import { describe, expect, it } from "vitest";
import { classify, type RequestInfo } from "./classify.js";

const POLICY = ["http://localhost:8080"];

function req(over: Partial<RequestInfo>): RequestInfo {
  return { tabId: 1, method: "GET", type: "script", url: "http://localhost:8080/app.js", ...over };
}

describe("classify", () => {
  it("filters a main_frame on a policy origin and takes its origin from the URL", () => {
    const r = classify(req({ type: "main_frame", url: "http://localhost:8080/" }), undefined, POLICY);
    expect(r).toEqual({ tabOrigin: "http://localhost:8080", filter: true });
  });

  it("main_frame origin ignores the previously recorded tab origin", () => {
    const r = classify(req({ type: "main_frame", url: "https://example.com/" }), "http://localhost:8080", POLICY);
    expect(r).toEqual({ tabOrigin: "https://example.com", filter: false });
  });

  it("filters a script on a policy tab", () => {
    expect(classify(req({}), "http://localhost:8080", POLICY).filter).toBe(true);
  });

  it("does not filter an image on a policy tab", () => {
    const r = classify(req({ type: "image", url: "http://localhost:8080/logo.png" }), "http://localhost:8080", POLICY);
    expect(r.filter).toBe(false);
  });

  it("does not filter a script on a non-policy tab", () => {
    const r = classify(req({ url: "https://example.com/app.js" }), "https://example.com", POLICY);
    expect(r).toEqual({ tabOrigin: "https://example.com", filter: false });
  });

  it("filters a cross-origin script on a policy tab (checked later as third-party)", () => {
    const r = classify(req({ url: "https://cdn.example.com/lib.js" }), "http://localhost:8080", POLICY);
    expect(r).toEqual({ tabOrigin: "http://localhost:8080", filter: true });
  });

  it("does not filter requests outside a tab (tabId -1)", () => {
    const r = classify(req({ tabId: -1 }), "http://localhost:8080", POLICY);
    expect(r.filter).toBe(false);
  });

  it("filters sub_frame and stylesheet on a policy tab", () => {
    expect(classify(req({ type: "sub_frame", url: "http://localhost:8080/f.html" }), "http://localhost:8080", POLICY).filter).toBe(true);
    expect(classify(req({ type: "stylesheet", url: "http://localhost:8080/a.css" }), "http://localhost:8080", POLICY).filter).toBe(true);
  });

  it("filters xmlhttprequest only when the path ends in .js", () => {
    const tab = "http://localhost:8080";
    expect(classify(req({ type: "xmlhttprequest", url: `${tab}/chunk.js?v=2` }), tab, POLICY).filter).toBe(true);
    expect(classify(req({ type: "xmlhttprequest", url: `${tab}/api/data.json` }), tab, POLICY).filter).toBe(false);
  });

  it("falls back to documentUrl, then originUrl, when no tab origin is recorded", () => {
    expect(classify(req({ documentUrl: "http://localhost:8080/index.html" }), undefined, POLICY))
      .toEqual({ tabOrigin: "http://localhost:8080", filter: true });
    expect(classify(req({ originUrl: "http://localhost:8080/" }), undefined, POLICY).filter).toBe(true);
  });

  it("does not filter when the tab origin is unknown", () => {
    expect(classify(req({}), undefined, POLICY)).toEqual({ tabOrigin: undefined, filter: false });
  });

  it("filters a worker on a policy tab", () => {
    expect(classify(req({ type: "worker" }), "http://localhost:8080", POLICY).filter).toBe(true);
  });

  it("does not filter HEAD or OPTIONS: their responses have no body", () => {
    const env = { url: "http://localhost:8080/runtime/window-env.js" };
    expect(classify(req({ ...env, method: "HEAD" }), "http://localhost:8080", POLICY).filter).toBe(false);
    expect(classify(req({ ...env, method: "OPTIONS" }), "http://localhost:8080", POLICY).filter).toBe(false);
    expect(classify(req({ ...env, method: "GET" }), "http://localhost:8080", POLICY).filter).toBe(true);
  });
});
