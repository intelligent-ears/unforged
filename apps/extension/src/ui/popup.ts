// Toolbar popup: shows what the background reports about the active tab.
import type { TabState, Verdict } from "@unforged/core";
import type { SyncSummary } from "../summary.js";
import { byId, detailList, el, showMockNotice } from "./dom.js";
import {
  blockedFileLabel,
  buildersCount,
  configValueText,
  dappOf,
  reasonText,
  relativeTime,
  shortAddress,
  shortCommit,
  statusLabel,
} from "./format.js";
import { isBlockedPage } from "../navigation.js";
import { stateSource, type StateSource } from "./source.js";

const BLOCKED_PAGE = browser.runtime.getURL("blocked.html");

function statusLine(level: Verdict["level"] | "error", text: string): HTMLElement {
  const dot = el("span", `dot dot-${level}`);
  dot.setAttribute("aria-hidden", "true");
  return el("p", "status", dot, el("strong", "", text));
}

/** Only a reproduced verdict names builders for the code in this tab. */
function buildersDetail(verdict: Verdict, total: number | undefined): HTMLElement | undefined {
  if (verdict.level !== "reproduced") return undefined;
  const addresses = verdict.builders.map((builder) => el("code", "address", shortAddress(builder)));
  return el("span", "", el("div", "", buildersCount(verdict.builders, total)), ...addresses);
}

function stateDetails(state: TabState, summary: SyncSummary | undefined): HTMLElement {
  const verdict = state.verdict;
  const dapp = dappOf(state);
  const release = state.release ?? ("release" in verdict ? verdict.release : undefined);
  const entry = summary?.dapps.find((d) => d.dapp === dapp);
  const commit = entry?.releases.find((r) => r.release === release)?.commit;
  return detailList([
    ["Dapp", dapp],
    ["Release", release],
    ["Commit", commit && shortCommit(commit)],
    ["Builders", buildersDetail(verdict, entry?.buildersTotal)],
    ["Files checked", dapp ? String(state.checked) : undefined],
  ]);
}

function blockedFiles(state: TabState): HTMLElement {
  const items = state.blocked.map((file) =>
    el("li", "", el("code", "file-path", blockedFileLabel(file)), el("span", "file-reason", reasonText(file.reason))),
  );
  return el("section", "", el("h2", "", "Blocked files"), el("ul", "file-list", ...items));
}

function configValues(values: Record<string, unknown>): HTMLElement {
  const rows = Object.entries(values).map(([key, value]): [string, string] => [key, configValueText(value)]);
  const list = detailList(rows);
  list.classList.add("config");
  return el("section", "", el("h2", "", "Accepted config"), list);
}

/** Last sync time, why the last sync failed (if it did), and "Sync now". */
function syncSection(source: StateSource, summary: SyncSummary | undefined, root: HTMLElement): HTMLElement {
  const when = summary ? relativeTime(summary.syncedAt) : "unavailable";
  const section = el("section", "sync", el("p", "", `Last sync: ${when}`));
  if (summary?.lastError) section.append(el("p", "sync-error", `Last sync failed: ${summary.lastError}`));
  if (source.mock) return section;

  const button = el("button", "", "Sync now");
  button.type = "button";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Syncing…";
    source
      .syncNow()
      .then(async (reply) => {
        await render(source, root);
        if ("error" in reply) root.append(el("p", "note", reply.error));
      })
      .catch((error: unknown) => root.append(el("p", "note", `Couldn't sync: ${String(error)}.`)));
  });
  section.append(button);
  return section;
}

async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Mock mode carries its fixture over to the blocked page instead of a tab id. */
function seeDetailsButton(source: StateSource, tab: browser.tabs.Tab | undefined, root: HTMLElement): HTMLElement {
  const button = el("button", "see-details", "See details");
  button.type = "button";
  button.addEventListener("click", () => {
    const search = source.mock ? location.search : `?tab=${tab?.id}`;
    const url = `${BLOCKED_PAGE}${search}`;
    const opening = tab?.id === undefined ? browser.tabs.update({ url }) : browser.tabs.update(tab.id, { url });
    opening
      .then(() => {
        if (!source.mock) window.close();
      })
      .catch((error: unknown) => root.append(el("p", "note", `Couldn't open the details: ${String(error)}.`)));
  });
  return button;
}

/** Never fall back to a verdict: if the state can't be read, say so. */
function showUnavailable(root: HTMLElement, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  root.replaceChildren(
    statusLine("error", "Status unavailable"),
    el("p", "note", `Unforged couldn't read this tab: ${message}.`),
  );
}

async function render(source: StateSource, root: HTMLElement): Promise<void> {
  const tab = source.mock ? undefined : await activeTab();
  const [state, summary] = await Promise.allSettled([source.getTabState(tab?.id), source.getSnapshotSummary()]);
  const snapshot = summary.status === "fulfilled" ? summary.value : undefined;

  if (state.status === "rejected") {
    showUnavailable(root, state.reason);
    root.append(syncSection(source, snapshot, root));
    return;
  }

  const { value } = state;
  root.replaceChildren(statusLine(value.verdict.level, statusLabel(value.verdict.level)), stateDetails(value, snapshot));
  if (value.blocked.length > 0) root.append(blockedFiles(value));
  // Already on the blocked page, another copy would only add a history entry for Go back to trip on.
  if (value.verdict.level === "mismatch" && !isBlockedPage(tab?.url ?? "", BLOCKED_PAGE)) {
    root.append(seeDetailsButton(source, tab, root));
  }
  if (value.configValues && Object.keys(value.configValues).length > 0) root.append(configValues(value.configValues));
  root.append(syncSection(source, snapshot, root));
}

async function main(): Promise<void> {
  const source = stateSource();
  const root = byId("app");
  try {
    await render(source, root);
  } catch (error) {
    showUnavailable(root, error);
  }
  if (source.mock) showMockNotice(root);
}

void main();
