// Background event page: buffers code responses on policy tabs, decides with decide.ts and
// applies the result (extension.md "Background: enforcement"). Also answers the UI's messages.
import type { Blocked, TabState, Verdict } from "@unforged/core";
import snapshotJson from "../fixtures/snapshot.json";
import { classify, originOf } from "./classify.js";
import { decide, newTab, type Snapshot, type TabRecord } from "./decide.js";
import { countsAsEvidence, keepsTabState, showsBlockedPage } from "./navigation.js";
import { snapshotSummary } from "./summary.js";

// Bundled fixture until M9 replaces it with the snapshot synced from Arkiv.
const snapshot = snapshotJson as unknown as Snapshot;
const policyOrigins = Object.values(snapshot.dapps).flatMap((d) => d.policy.origins);

const BLOCKED_BODY_LIMIT = 200 * 1024;
const SCRIPT_TYPES = new Set(["script", "worker", "xmlhttprequest"]);
const BLOCKED_PAGE = browser.runtime.getURL("blocked.html");

interface Tab {
  origin: string | undefined;
  record: TabRecord;
  blockedBodies: Map<string, string>; // url -> first 200 KB of a blocked script, memory only
  documentPending: boolean; // a policy document is loading and hasn't committed yet
  blockedPageShown: boolean; // this page load already went to the blocked page
}

const tabs = new Map<number, Tab>();

function newTabEntry(origin: string | undefined): Tab {
  return { origin, record: newTab(), blockedBodies: new Map(), documentPending: false, blockedPageShown: false };
}

function tabFor(tabId: number): Tab {
  let tab = tabs.get(tabId);
  if (!tab) {
    tab = newTabEntry(undefined);
    tabs.set(tabId, tab);
  }
  return tab;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Close without writing: the browser receives an empty body (fail closed). */
function closeEmpty(filter: browser.webRequest.StreamFilter): void {
  try {
    filter.close();
  } catch {
    // Already closed or errored; nothing was written either way.
  }
}

const BADGES: Record<Verdict["level"], { text: string; color: string }> = {
  reproduced: { text: "OK", color: "#2e7d32" },
  vendor: { text: "OK", color: "#f9a825" },
  mismatch: { text: "!", color: "#c62828" },
  unsupported: { text: "", color: "#9e9e9e" },
};

async function showState(tabId: number): Promise<void> {
  const state = tabs.get(tabId)?.record.state;
  if (!state) return;
  const badge = BADGES[state.verdict.level];
  try {
    await browser.action.setBadgeText({ tabId, text: badge.text });
    await browser.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    await browser.storage.session.set({ [`tab:${tabId}`]: state });
  } catch (error) {
    console.error("unforged: could not publish tab state", { tabId, error });
  }
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A 0-byte response where the manifest expects content: still blocked, but logged distinctly. */
function emptyBodyExpected(body: Uint8Array, blocked: Blocked | undefined): boolean {
  return body.byteLength === 0 && blocked?.expected !== undefined && blocked.expected !== EMPTY_SHA256;
}

function keepBlockedBody(tab: Tab, details: browser.webRequest._OnBeforeRequestDetails, body: Uint8Array): void {
  if (!SCRIPT_TYPES.has(details.type)) return;
  const text = new TextDecoder().decode(body.subarray(0, BLOCKED_BODY_LIMIT));
  tab.blockedBodies.set(details.url, text);
}

/**
 * Takes the tab to the blocked page, once per page load. Skips a tab that has moved on since the
 * request started, and a page whose own origin isn't the policy origin (say, a site embedding a
 * policy-origin frame): a block there must not take over the whole tab.
 */
async function showBlockedPage(tabId: number, tab: Tab, tabOrigin: string, requestType: string): Promise<void> {
  if (!showsBlockedPage(requestType) || tab.blockedPageShown) return;
  if (tabs.get(tabId) !== tab || tab.origin !== tabOrigin) return;
  tab.blockedPageShown = true;
  await browser.tabs.update(tabId, { url: `${BLOCKED_PAGE}?tab=${tabId}` });
}

function filterBody(details: browser.webRequest._OnBeforeRequestDetails, tabOrigin: string): void {
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks: Uint8Array[] = [];
  const tab = tabFor(details.tabId); // the page this request belongs to, even if the tab moves on
  let failed = false;

  filter.ondata = (event) => {
    chunks.push(new Uint8Array(event.data));
  };

  filter.onstop = async () => {
    const body = concat(chunks);
    const interrupted = failed || Boolean(filter.error);
    if (!countsAsEvidence({ blockedPageShown: tab.blockedPageShown, interrupted, bodyBytes: body.byteLength })) {
      // Cut off by the move to the blocked page, or by a failed request: block, record nothing.
      console.warn("unforged: blocked, not recorded (interrupted)", { url: details.url, bytes: body.byteLength });
      closeEmpty(filter);
      return;
    }
    try {
      const decision = await decide(snapshot, tab.record, { url: details.url, type: details.type, tabOrigin, body });
      if (decision.allow) {
        filter.write(body);
        filter.close();
      } else {
        const label = emptyBodyExpected(body, decision.blocked) ? "unforged: blocked, empty body" : "unforged: blocked";
        console.warn(label, decision.blocked);
        closeEmpty(filter);
        keepBlockedBody(tab, details, body);
        await showBlockedPage(details.tabId, tab, tabOrigin, details.type);
      }
    } catch (error) {
      console.error("unforged: blocked, enforcement failed", { url: details.url, error });
      closeEmpty(filter);
    }
    if (tabs.get(details.tabId) === tab) await showState(details.tabId);
  };

  filter.onerror = () => {
    failed = true;
    console.error("unforged: stream filter error", { url: details.url, error: filter.error });
    if (details.type === "main_frame") tab.documentPending = false;
  };

  if (details.type === "main_frame") tab.documentPending = true;
}

function onBeforeRequest(
  details: browser.webRequest._OnBeforeRequestDetails,
): browser.webRequest.BlockingResponse {
  if (details.tabId < 0 || details.url.startsWith(browser.runtime.getURL(""))) return {};
  const { tabOrigin, filter } = classify(details, tabs.get(details.tabId)?.origin, policyOrigins);
  if (details.type === "main_frame") {
    // Top-level navigation resets the tab; decide() fills in the dapp once the document is checked.
    tabs.set(details.tabId, newTabEntry(tabOrigin));
    void showState(details.tabId);
  }
  if (!filter || !tabOrigin) return {};
  try {
    filterBody(details, tabOrigin);
    return {};
  } catch (error) {
    // Couldn't attach a filter, so the body can't be checked: cancel instead of allowing.
    console.error("unforged: blocked, could not filter", { url: details.url, error });
    return { cancel: true };
  }
}

// ---- Navigation that webRequest doesn't see (about:, file:, extension pages) ----

/** Drops a stale verdict. Keeps the page's own origin, which its frames' scripts classify against. */
async function resetTab(tabId: number, url: string): Promise<void> {
  tabs.set(tabId, newTabEntry(originOf(url)));
  try {
    await browser.action.setBadgeText({ tabId, text: "" });
    await browser.storage.session.remove(`tab:${tabId}`);
  } catch (error) {
    console.error("unforged: could not clear tab state", { tabId, error });
  }
}

function onTabUrlChanged(tabId: number, url: string): void {
  const tab = tabs.get(tabId);
  if (keepsTabState(url, policyOrigins, BLOCKED_PAGE)) {
    if (tab) tab.documentPending = false;
    return;
  }
  // The page being left can still change its URL (pushState) while a policy document loads. That
  // must not replace the record, or the document's scripts would inherit the wrong origin and
  // skip verification.
  if (!tab?.documentPending) void resetTab(tabId, url);
}

// ---- Messages (extension.md "Messages the background answers") ----

type Message =
  | { type: "getTabState"; tabId: number }
  | { type: "getSnapshotSummary" }
  | { type: "getBlockedBody"; tabId: number; url: string };

async function getTabState(tabId: number): Promise<TabState> {
  const inMemory = tabs.get(tabId)?.record.state;
  if (inMemory) return inMemory;
  const key = `tab:${tabId}`;
  const stored = (await browser.storage.session.get(key))[key] as TabState | undefined;
  return stored ?? newTab().state;
}

function getBlockedBody(tabId: number, url: string): { body: string } | { error: string } {
  const body = tabs.get(tabId)?.blockedBodies.get(url);
  return body === undefined ? { error: "no blocked body kept for this file" } : { body };
}

function onMessage(message: Message, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (sender.id !== browser.runtime.id) return undefined;
  switch (message?.type) {
    case "getTabState":
      return getTabState(message.tabId);
    case "getSnapshotSummary":
      return Promise.resolve(snapshotSummary(snapshot));
    case "getBlockedBody":
      return Promise.resolve(getBlockedBody(message.tabId, message.url));
    default:
      return undefined;
  }
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] }, ["blocking"]);
browser.runtime.onMessage.addListener(onMessage);
// Firefox may reset per-tab badges when a page commits; repaint from our state.
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) onTabUrlChanged(tabId, change.url);
  if (change.status && tab.url && keepsTabState(tab.url, policyOrigins, BLOCKED_PAGE)) void showState(tabId);
});
browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  void browser.storage.session.remove(`tab:${tabId}`);
});
