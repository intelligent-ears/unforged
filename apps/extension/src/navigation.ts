// Pure rules for what a top-level navigation does to a tab's state, and when a block takes the
// tab to the blocked page. No browser APIs here, so they are unit-tested directly.
import { originOf } from "./classify.js";

const BLOCKED_PAGE_TYPES = new Set(["main_frame", "sub_frame", "script", "stylesheet", "worker"]);

export function isBlockedPage(url: string, blockedPageUrl: string): boolean {
  return url.split(/[?#]/, 1)[0] === blockedPageUrl;
}

/** A verdict stays valid on its policy origin and on the page explaining it; anywhere else it's stale. */
export function keepsTabState(url: string, policyOrigins: readonly string[], blockedPageUrl: string): boolean {
  if (isBlockedPage(url, blockedPageUrl)) return true;
  const origin = originOf(url);
  return origin !== undefined && policyOrigins.includes(origin);
}

/** Whether blocking a request of this type leaves the page too broken to stay on. */
export function showsBlockedPage(requestType: string): boolean {
  return BLOCKED_PAGE_TYPES.has(requestType);
}

export interface FinishedResponse {
  blockedPageShown: boolean; // this page load already went to the blocked page
  interrupted: boolean; // the stream filter errored or the request was cut off
  bodyBytes: number;
}

/**
 * Whether a finished response says anything about the release. It is blocked either way (fail
 * closed); this only decides whether it is recorded in TabState.blocked. Downloads cut off by
 * the move to the blocked page, and empty bodies from interrupted requests, are not evidence.
 */
export function countsAsEvidence({ blockedPageShown, interrupted, bodyBytes }: FinishedResponse): boolean {
  if (blockedPageShown) return false;
  return !(interrupted && bodyBytes === 0);
}
