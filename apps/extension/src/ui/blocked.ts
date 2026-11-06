// Blocked page: explains what the background blocked in tab ?tab=<id>. The red header is in the
// HTML, so it stays up unless the background reports that nothing is blocked.
import type { Blocked, TabState } from "@unforged/core";
import type { SyncSummary } from "../summary.js";
import { byId, el, showMockNotice } from "./dom.js";
import {
  blockedFileLabel,
  dappOf,
  parseTabId,
  reasonText,
  shortHash,
  statusLabel,
  verifiedCopyAvailable,
} from "./format.js";
import { stateSource, type StateSource } from "./source.js";

const NOT_MIRRORED = "No verified copy of this release is available yet.";
const DID_NOT_OPEN = "The verified copy didn't open.";
const OPEN_TIMEOUT_MS = 3000;
const MIN_HISTORY_TO_GO_BACK = 3;
const BACK_TIMEOUT_MS = 2000;

function hashLine(label: string, hash: string | undefined): HTMLElement {
  const value = hash ? el("code", "", shortHash(hash)) : "none";
  return el("span", "hash", `${label} `, value);
}

function fileItem(file: Blocked): HTMLElement {
  return el(
    "li",
    "",
    el("code", "file-path", blockedFileLabel(file)),
    el("span", "file-reason", reasonText(file.reason)),
    el("span", "hashes", hashLine("expected", file.expected), hashLine("actual", file.actual)),
  );
}

function showBlocked(state: TabState): void {
  byId("files").replaceChildren(
    el("h2", "", state.blocked.length === 1 ? "Blocked file" : "Blocked files"),
    el("ul", "file-list", ...state.blocked.map(fileItem)),
  );
}

/** The background reports nothing blocked, so the page must not claim otherwise. */
function showNothingBlocked(state: TabState): void {
  document.documentElement.dataset.state = "clear";
  byId("title").textContent = statusLabel(state.verdict.level);
  byId("explanation").textContent =
    "Unforged has no blocked files on record for this tab. If it sent you here, reload the page to check it again.";
}

function showDetailsUnavailable(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  byId("explanation").textContent = `This page stays blocked, but Unforged couldn't load the details: ${message}.`;
}

function disableCopyButton(button: HTMLButtonElement, reason: string): void {
  button.disabled = true;
  button.title = reason;
  byId("copy-note").textContent = reason;
}

/** The background navigates on success. If this page is still here afterwards, it didn't work. */
async function openVerifiedCopy(
  source: StateSource,
  tabId: number | undefined,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const reply = (await source.openVerifiedCopy(tabId)) as { error?: string } | undefined;
    if (reply?.error) throw new Error(reply.error);
    setTimeout(() => disableCopyButton(button, DID_NOT_OPEN), OPEN_TIMEOUT_MS);
  } catch {
    disableCopyButton(button, DID_NOT_OPEN);
  }
}

function setUpCopyButton(source: StateSource, tabId: number | undefined, available: boolean): void {
  const button = byId<HTMLButtonElement>("open-copy");
  if (!available) {
    disableCopyButton(button, NOT_MIRRORED);
    return;
  }
  button.disabled = false;
  button.addEventListener("click", () => void openVerifiedCopy(source, tabId, button));
}

async function load(source: StateSource, tabId: number | undefined): Promise<void> {
  const [state, summary] = await Promise.allSettled([source.getTabState(tabId), source.getSnapshotSummary()]);
  const snapshot: SyncSummary | undefined = summary.status === "fulfilled" ? summary.value : undefined;
  if (state.status === "rejected") {
    showDetailsUnavailable(state.reason);
    setUpCopyButton(source, tabId, false);
    return;
  }
  if (state.value.verdict.level === "mismatch") showBlocked(state.value);
  else showNothingBlocked(state.value);
  setUpCopyButton(source, tabId, verifiedCopyAvailable(snapshot, dappOf(state.value)));
}

function main(): void {
  const source = stateSource();
  const tabId = parseTabId(location.search);
  byId("go-back").addEventListener("click", goBack);
  if (source.mock) showMockNotice(byId("app"));
  load(source, tabId).catch(showDetailsUnavailable);
}

function leaveToBlank(): void {
  void browser.tabs.update({ url: "about:blank" });
}

/**
 * After a block, history is [previous page, blocked dapp, this page]. One step back would fetch
 * the dapp and block it again, so go two. With less history, or if going back does nothing, leave
 * for about:blank (Firefox refuses about:home from an extension).
 */
function goBack(): void {
  if (history.length < MIN_HISTORY_TO_GO_BACK) {
    leaveToBlank();
    return;
  }
  const fallback = setTimeout(leaveToBlank, BACK_TIMEOUT_MS);
  addEventListener("pagehide", () => clearTimeout(fallback), { once: true });
  history.go(-2);
}

main();
