import { describe, expect, it } from "vitest";
import { classify, originOf, type RecordedTab, type RequestInfo } from "./classify.js";
import type { Site } from "./site.js";

const DAPP: Site = { dapp: "demo", base: "http://localhost:8080/" };
const MIRROR: Site = { dapp: "demo", base: "https://mirror.example.org/m/demo-2/" };
const POLICY = (url: string | undefined): Site | undefined => {
  if (url?.startsWith(MIRROR.base)) return MIRROR;
  return originOf(url) === "http://localhost:8080" ? DAPP : undefined;
};
/** The record a tab gets from a main_frame at this URL. */
const at = (url: string): RecordedTab => ({ origin: originOf(url), site: POLICY(url) });

function req(over: Partial<RequestInfo>): RequestInfo {
  return { tabId: 1, method: "GET", type: "script", url: "http://localhost:8080/app.js", ...over };
}

describe("classify", () => {
  it("filters a main_frame on a policy origin and takes its origin from the URL", () => {
    const r = classify(req({ type: "main_frame", url: "http://localhost:8080/" }), undefined, POLICY);
    expect(r).toEqual({ tabOrigin: "http://localhost:8080", site: DAPP, filter: true });
  });

  it("main_frame origin ignores the previously recorded tab origin", () => {
    const r = classify(req({ type: "main_frame", url: "https://example.com/" }), at("http://localhost:8080"), POLICY);
    expect(r).toEqual({ tabOrigin: "https://example.com", site: undefined, filter: false });
  });

  it("filters a script on a policy tab", () => {
    expect(classify(req({}), at("http://localhost:8080"), POLICY).filter).toBe(true);
  });

  it("does not filter an image on a policy tab", () => {
    const r = classify(req({ type: "image", url: "http://localhost:8080/logo.png" }), at("http://localhost:8080"), POLICY);
    expect(r.filter).toBe(false);
  });

  it("does not filter a script on a non-policy tab", () => {
    const r = classify(req({ url: "https://example.com/app.js" }), at("https://example.com"), POLICY);
    expect(r).toEqual({ tabOrigin: "https://example.com", site: undefined, filter: false });
  });

  it("filters a cross-origin script on a policy tab (checked later as third-party)", () => {
    const r = classify(req({ url: "https://cdn.example.com/lib.js" }), at("http://localhost:8080"), POLICY);
    expect(r).toEqual({ tabOrigin: "http://localhost:8080", site: DAPP, filter: true });
  });

  it("does not filter requests outside a tab (tabId -1)", () => {
    const r = classify(req({ tabId: -1 }), at("http://localhost:8080"), POLICY);
    expect(r.filter).toBe(false);
  });

  it("filters sub_frame and stylesheet on a policy tab", () => {
    expect(classify(req({ type: "sub_frame", url: "http://localhost:8080/f.html" }), at("http://localhost:8080"), POLICY).filter).toBe(true);
    expect(classify(req({ type: "stylesheet", url: "http://localhost:8080/a.css" }), at("http://localhost:8080"), POLICY).filter).toBe(true);
  });

  it("filters xmlhttprequest only when the path ends in .js", () => {
    const tab = "http://localhost:8080";
    expect(classify(req({ type: "xmlhttprequest", url: `${tab}/chunk.js?v=2` }), at(tab), POLICY).filter).toBe(true);
    expect(classify(req({ type: "xmlhttprequest", url: `${tab}/api/data.json` }), at(tab), POLICY).filter).toBe(false);
  });

  it("falls back to documentUrl, then originUrl, when no tab origin is recorded", () => {
    expect(classify(req({ documentUrl: "http://localhost:8080/index.html" }), undefined, POLICY))
      .toEqual({ tabOrigin: "http://localhost:8080", site: DAPP, filter: true });
    expect(classify(req({ originUrl: "http://localhost:8080/" }), undefined, POLICY).filter).toBe(true);
  });

  it("does not filter when the tab origin is unknown", () => {
    expect(classify(req({}), undefined, POLICY)).toEqual({ tabOrigin: undefined, site: undefined, filter: false });
  });

  it("filters a worker on a policy tab", () => {
    expect(classify(req({ type: "worker" }), at("http://localhost:8080"), POLICY).filter).toBe(true);
  });

  it("does not filter HEAD or OPTIONS: their responses have no body", () => {
    const env = { url: "http://localhost:8080/runtime/window-env.js" };
    expect(classify(req({ ...env, method: "HEAD" }), at("http://localhost:8080"), POLICY).filter).toBe(false);
    expect(classify(req({ ...env, method: "OPTIONS" }), at("http://localhost:8080"), POLICY).filter).toBe(false);
    expect(classify(req({ ...env, method: "GET" }), at("http://localhost:8080"), POLICY).filter).toBe(true);
  });

  it("keeps a mirror tab's site from its document, not its origin", () => {
    const tab = at("https://mirror.example.org/m/demo-2/");
    expect(tab.site).toBe(MIRROR);
    expect(classify(req({ url: "https://mirror.example.org/m/demo-2/a.js" }), tab, POLICY).site).toBe(MIRROR);
    // A later same-origin URL (pushState) can't move the tab out of its site.
    expect(classify(req({ url: "https://mirror.example.org/other.js" }), tab, POLICY)).toMatchObject({ site: MIRROR, filter: true });
  });

  it("doesn't check other pages on the mirror host", () => {
    const tab = at("https://mirror.example.org/blog/");
    expect(classify(req({ url: "https://mirror.example.org/blog/a.js" }), tab, POLICY).filter).toBe(false);
    expect(classify(req({ type: "main_frame", url: "https://mirror.example.org/m/demo-2/" }), tab, POLICY).filter).toBe(true);
  });

  it("finds a mirror tab's site from the document URL when nothing is recorded", () => {
    const r = classify(req({ documentUrl: "https://mirror.example.org/m/demo-2/index.html" }), undefined, POLICY);
    expect(r).toMatchObject({ tabOrigin: "https://mirror.example.org", site: MIRROR, filter: true });
  });
});
