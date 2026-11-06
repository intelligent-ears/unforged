// Pure request classification: which tab a request belongs to, and whether its body must be checked.
// No browser APIs here, so it is unit-tested directly.
import type { Site } from "./site.js";

/** The subset of webRequest details that classification reads. */
export interface RequestInfo {
  tabId: number;
  method: string;
  type: string;
  url: string;
  documentUrl?: string;
  originUrl?: string;
}

/** What the background recorded for a tab at its last top-level navigation. */
export interface RecordedTab {
  origin: string | undefined;
  site: Site | undefined;
}

/** The site a top-level document URL belongs to (site.ts siteFor over the current snapshot). */
export type SiteAt = (url: string | undefined) => Site | undefined;

export interface Classification {
  /** Top-level origin of the tab, or undefined if it can't be determined. */
  tabOrigin: string | undefined;
  /** The dapp site the tab's document came from, if any. */
  site: Site | undefined;
  /** True if the response body must be buffered and checked. */
  filter: boolean;
}

/** Methods whose responses carry no body: nothing to verify or execute. */
const BODYLESS_METHODS = new Set(["HEAD", "OPTIONS"]);

// "worker" is not a Firefox ResourceType today; listed so it is checked if Firefox ever reports it.
const CODE_TYPES = new Set(["main_frame", "sub_frame", "script", "stylesheet", "worker"]);

export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function pathEndsInJs(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith(".js");
  } catch {
    return false;
  }
}

/** main_frame defines the tab's origin; everything else inherits the recorded one, then the initiator. */
export function tabOriginFor(details: RequestInfo, recordedOrigin: string | undefined): string | undefined {
  if (details.type === "main_frame") return originOf(details.url);
  return recordedOrigin ?? originOf(details.documentUrl) ?? originOf(details.originUrl);
}

/** Code-carrying request types. Cross-origin files are included: they are checked later as third-party. */
export function isCodeRequest(details: RequestInfo): boolean {
  if (BODYLESS_METHODS.has(details.method.toUpperCase())) return false;
  if (CODE_TYPES.has(details.type)) return true;
  return details.type === "xmlhttprequest" && pathEndsInJs(details.url);
}

/**
 * main_frame finds its site from its URL. Everything else keeps the site recorded for the tab: on
 * a mirror the site is a folder, and a URL change after the document loaded (pushState) must not
 * move the tab out of it. With nothing recorded, the request's document stands in.
 */
export function siteForRequest(details: RequestInfo, recorded: RecordedTab | undefined, siteAt: SiteAt): Site | undefined {
  if (details.type === "main_frame") return siteAt(details.url);
  if (recorded?.origin !== undefined) return recorded.site;
  return siteAt(details.documentUrl) ?? siteAt(details.originUrl);
}

export function classify(details: RequestInfo, recorded: RecordedTab | undefined, siteAt: SiteAt): Classification {
  const tabOrigin = tabOriginFor(details, recorded?.origin);
  const site = siteForRequest(details, recorded, siteAt);
  const filter = details.tabId >= 0 && site !== undefined && isCodeRequest(details);
  return { tabOrigin, site, filter };
}
