import { describe, expect, it } from "vitest";
import { gatewayUrl } from "./index.js";

const GATEWAY = "https://intelligent-ears.github.io/unforged-mirror/";

describe("gatewayUrl", () => {
  it("joins gateway, ref and path with no double slashes", () => {
    expect(gatewayUrl(GATEWAY, "lido-0.161.0", "/index.html")).toBe("https://intelligent-ears.github.io/unforged-mirror/lido-0.161.0/index.html");
    expect(gatewayUrl("https://mirror.example/", "a", "/")).toBe("https://mirror.example/a/");
  });

  it("keeps the bracketed paths Next.js emits as they are", () => {
    const path = "/_next/static/chunks/pages/wrap/[[...mode]]-4890876573a1a234.js";
    expect(gatewayUrl(GATEWAY, "a", path)).toBe(`${GATEWAY}a${path}`);
  });

  it.each([
    ["http", "http://mirror.example/"],
    ["no trailing slash", "https://mirror.example/base"],
    ["not a URL", "mirror/"],
    ["empty", ""],
    ["a double slash", "https://mirror.example//base/"],
    ["a query", "https://mirror.example/?a=/"],
    ["a fragment", "https://mirror.example/#/"],
    ["credentials", "https://user:pass@mirror.example/"],
    ["a dot segment", "https://mirror.example/a/../"],
  ])("rejects a gateway with %s", (_, gateway) => {
    expect(() => gatewayUrl(gateway, "a", "/index.html")).toThrow(/gateway/);
  });

  it.each(["", "-a", ".a", "A", "a/b", "a b", "a_b", "../a", "a\n"])("rejects the ref %j", (ref) => {
    expect(() => gatewayUrl(GATEWAY, ref, "/index.html")).toThrow(/ref/);
  });

  it.each([
    ["no leading slash", "index.html"],
    ["empty", ""],
    ["a double slash", "//evil.example/x.js"],
    ["a parent segment", "/../other-ref/x.js"],
    ["an encoded parent segment", "/%2e%2E/other-ref/x.js"],
    ["a query", "/x.js?y"],
    ["a fragment", "/x.js#y"],
    ["a backslash", "/..\\x.js"],
    ["a control character", "/a\n/x.js"],
  ])("rejects a path with %s", (_, path) => {
    expect(() => gatewayUrl(GATEWAY, "a", path)).toThrow(/path/);
  });
});
