// Background event page: observes code requests on policy tabs and buffers their bodies.
// This milestone only hashes and logs; checking against a release comes later.
import { sha256Hex } from "@unforged/core";
import { classify } from "./classify.js";
import { POLICY_ORIGINS } from "./config.js";

interface CheckedFile {
  url: string;
  type: string;
  sha256: string;
  bytes: number;
}

interface TabState {
  origin: string | undefined;
  checked: CheckedFile[];
}

const tabs = new Map<number, TabState>();

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
function closeEmpty(filter: browser.webRequest.StreamFilter, url: string, error: unknown): void {
  console.error("unforged: blocked, filter failed", { url, error });
  try {
    filter.close();
  } catch {
    // Already closed or errored; nothing was written either way.
  }
}

function filterBody(details: browser.webRequest._OnBeforeRequestDetails): void {
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks: Uint8Array[] = [];

  filter.ondata = (event) => {
    chunks.push(new Uint8Array(event.data));
  };

  filter.onstop = async () => {
    try {
      const body = concat(chunks);
      const sha256 = await sha256Hex(body);
      const file = { url: details.url, type: details.type, sha256, bytes: body.byteLength };
      console.log(file);
      tabs.get(details.tabId)?.checked.push(file);
      filter.write(body);
      filter.close();
    } catch (error) {
      closeEmpty(filter, details.url, error);
    }
  };

  filter.onerror = () => {
    console.error("unforged: stream filter error", { url: details.url, error: filter.error });
  };
}

function onBeforeRequest(
  details: browser.webRequest._OnBeforeRequestDetails,
): browser.webRequest.BlockingResponse {
  const { tabOrigin, filter } = classify(details, tabs.get(details.tabId)?.origin, POLICY_ORIGINS);
  if (details.type === "main_frame" && details.tabId >= 0) {
    tabs.set(details.tabId, { origin: tabOrigin, checked: [] });
  }
  if (!filter) return {};
  try {
    filterBody(details);
    return {};
  } catch (error) {
    // Couldn't attach a filter, so the body can't be checked: cancel instead of allowing.
    console.error("unforged: blocked, could not filter", { url: details.url, error });
    return { cancel: true };
  }
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] }, ["blocking"]);
browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
