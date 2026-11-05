// Pure request classification: which tab a request belongs to, and whether its body must be checked.
// No browser APIs here, so it is unit-tested directly.

/** The subset of webRequest details that classification reads. */
export interface RequestInfo {
  tabId: number;
  type: string;
  url: string;
  documentUrl?: string;
  originUrl?: string;
}

export interface Classification {
  /** Top-level origin of the tab, or undefined if it can't be determined. */
  tabOrigin: string | undefined;
  /** True if the response body must be buffered and checked. */
  filter: boolean;
}

const CODE_TYPES = new Set(["main_frame", "sub_frame", "script", "stylesheet"]);

function originOf(url: string | undefined): string | undefined {
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
  if (CODE_TYPES.has(details.type)) return true;
  return details.type === "xmlhttprequest" && pathEndsInJs(details.url);
}

export function classify(
  details: RequestInfo,
  recordedOrigin: string | undefined,
  policyOrigins: readonly string[],
): Classification {
  const tabOrigin = tabOriginFor(details, recordedOrigin);
  const inPolicy = tabOrigin !== undefined && policyOrigins.includes(tabOrigin);
  const filter = details.tabId >= 0 && inPolicy && isCodeRequest(details);
  return { tabOrigin, filter };
}
