// Background event page: buffers code responses on policy tabs, decides with decide.ts and
// applies the result (extension.md "Background: enforcement"). Also answers the UI's messages.
// The snapshot comes from the periodic sync in snapshots.ts.
import type { Blocked, TabState, Verdict } from "@unforged/core";
import { classify, originOf } from "./classify.js";
import { decide, newTab, type TabRecord } from "./decide.js";
import { countsAsEvidence, keepsTabState, showsBlockedPage } from "./navigation.js";
import { pathIn, siteFor, verifiedCopyUrl, type Site } from "./site.js";
import { currentSnapshot, ready, scheduleSync, summary, syncNow } from "./snapshots.js";

let snapshotLoaded = false;
void ready.then(() => {
  snapshotLoaded = true;
});

/** The site of a top-level document URL in the current snapshot. */
function siteAt(url: string | undefined): Site | undefined {
  const snapshot = currentSnapshot();
  return snapshot ? siteFor(snapshot, url) : undefined;
}

const BLOCKED_BODY_LIMIT = 200 * 1024;
const SCRIPT_TYPES = new Set(["script", "worker", "xmlhttprequest"]);
const BLOCKED_PAGE = browser.runtime.getURL("blocked.html");

interface Tab {
  origin: string | undefined;
  site: Site | undefined; // the dapp site of the top-level document, fixed for the page load
  path: string; // that document's path inside the site, for "Open verified copy"
  record: TabRecord;
  blockedBodies: Map<string, string>; // url -> first 200 KB of a blocked script, memory only
  documentPending: boolean; // a policy document is loading and hasn't committed yet
  blockedPageShown: boolean; // this page load already went to the blocked page
}

const tabs = new Map<number, Tab>();

function newTabEntry(origin: string | undefined, site?: Site, path = "/"): Tab {
  return { origin, site, path, record: newTab(), blockedBodies: new Map(), documentPending: false, blockedPageShown: false };
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

function filterBody(details: browser.webRequest._OnBeforeRequestDetails, tabOrigin: string, site: Site): void {
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
      const snapshot = currentSnapshot();
      if (!snapshot) throw new Error("no snapshot");
      const request = { url: details.url, type: details.type, tabOrigin, site, body };
      const decision = await decide(snapshot, tab.record, request);
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

/** The document's path in its site, if it can be read; "Open verified copy" falls back to "/". */
function documentPath(site: Site | undefined, url: string): string {
  try {
    return (site && pathIn(site, url)) ?? "/";
  } catch {
    return "/";
  }
}

/** Until the stored snapshot is loaded, which sites to check is unknown: hold requests until it is. */
function onBeforeRequest(
  details: browser.webRequest._OnBeforeRequestDetails,
): browser.webRequest.BlockingResponse | Promise<browser.webRequest.BlockingResponse> {
  if (!snapshotLoaded) return ready.then(() => handleRequest(details));
  return handleRequest(details);
}

function handleRequest(details: browser.webRequest._OnBeforeRequestDetails): browser.webRequest.BlockingResponse {
  if (details.tabId < 0 || details.url.startsWith(browser.runtime.getURL(""))) return {};
  const { tabOrigin, site, filter } = classify(details, tabs.get(details.tabId), siteAt);
  if (details.type === "main_frame") {
    // Top-level navigation resets the tab; decide() fills in the dapp once the document is checked.
    tabs.set(details.tabId, newTabEntry(tabOrigin, site, documentPath(site, details.url)));
    void showState(details.tabId);
  }
  if (!filter || !tabOrigin || !site) return {};
  try {
    filterBody(details, tabOrigin, site);
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

/**
 * Whether a URL is still on the tab's dapp: a policy origin or mirror folder, or the host of the
 * tab's own site, which a mirror page's pushState can move to without leaving the page.
 */
function onSite(tab: Tab | undefined, url: string): boolean {
  if (siteAt(url) !== undefined) return true;
  return tab?.site !== undefined && originOf(url) === originOf(tab.site.base);
}

function onTabUrlChanged(tabId: number, url: string): void {
  const tab = tabs.get(tabId);
  if (keepsTabState(url, (u) => onSite(tab, u), BLOCKED_PAGE)) {
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
  | { type: "getBlockedBody"; tabId: number; url: string }
  | { type: "openVerifiedCopy"; tabId: number }
  | { type: "syncNow" };

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

/** Sends the tab to the mirrored copy of its release (or the newest mirrored one), at the same path. */
async function openVerifiedCopy(tabId: number): Promise<{ ok: true } | { error: string }> {
  await ready;
  const snapshot = currentSnapshot();
  const tab = tabs.get(tabId);
  if (!snapshot || !tab) return { error: "nothing is known about this tab" };
  const target = verifiedCopyUrl(snapshot, tab.site?.dapp ?? tab.record.state.dapp, tab.record.lock, tab.path);
  if ("error" in target) return target;
  await browser.tabs.update(tabId, { url: target.url });
  return { ok: true };
}

function onMessage(message: Message, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (sender.id !== browser.runtime.id) return undefined;
  switch (message?.type) {
    case "getTabState":
      return getTabState(message.tabId);
    case "getSnapshotSummary":
      return ready.then(summary);
    case "getBlockedBody":
      return Promise.resolve(getBlockedBody(message.tabId, message.url));
    case "openVerifiedCopy":
      return openVerifiedCopy(message.tabId).catch((error: unknown) => ({ error: String(error) }));
    case "syncNow":
      return syncNow();
    default:
      return undefined;
  }
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] }, ["blocking"]);
browser.runtime.onMessage.addListener(onMessage);
// Firefox may reset per-tab badges when a page commits; repaint from our state.
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) onTabUrlChanged(tabId, change.url);
  const record = tabs.get(tabId);
  if (change.status && tab.url && keepsTabState(tab.url, (u) => onSite(record, u), BLOCKED_PAGE)) void showState(tabId);
});
browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  void browser.storage.session.remove(`tab:${tabId}`);
});
scheduleSync();
