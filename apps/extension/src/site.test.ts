import { describe, expect, it } from "vitest";
import type { AcceptedRelease, Policy } from "@unforged/core";
import type { Snapshot } from "./decide.js";
import { mirrorUrl, pathIn, siteFor, verifiedCopyUrl } from "./site.js";

const ORIGIN = "http://localhost:8080";
const GATEWAY = "https://mirror.example.org/unforged-mirror/";

function release(name: string, swarmRefs: string[]): AcceptedRelease {
  return {
    dapp: "demo",
    release: name,
    commit: "c".repeat(40),
    manifestRoot: name.padEnd(64, "0"),
    manifest: { version: 1, dapp: "demo", release: name, commit: "c".repeat(40), files: {}, config: {} },
    builders: [],
    builtAt: "2026-11-01T00:00:00Z",
    swarmRefs,
  };
}

function snapshot(gateway: string, releases: AcceptedRelease[]): Snapshot {
  const policy: Policy = {
    dapp: "demo",
    origins: [ORIGIN],
    repo: "https://github.com/example/demo",
    builders: [],
    threshold: 1,
    acceptLatest: 3,
    thirdParty: {},
    recovery: { gateway },
  };
  return { syncedAt: null, dapps: { demo: { policy, releases, policyVersion: 1 } } };
}

const NEW = release("2.0.0", ["demo-2.0.0"]);
const OLD = release("1.0.0", ["demo-1.0.0"]);
const BARE = release("3.0.0", []);

describe("siteFor", () => {
  const snap = snapshot(GATEWAY, [NEW, OLD]);

  it("finds the dapp on a policy origin, any path", () => {
    expect(siteFor(snap, `${ORIGIN}/earn?x=1`)).toEqual({ dapp: "demo", base: `${ORIGIN}/` });
    expect(siteFor(snap, ORIGIN)).toEqual({ dapp: "demo", base: `${ORIGIN}/` });
  });

  it("finds the release a mirror folder belongs to", () => {
    expect(siteFor(snap, `${GATEWAY}demo-1.0.0/`)).toEqual({ dapp: "demo", base: `${GATEWAY}demo-1.0.0/`, mirror: OLD });
    expect(siteFor(snap, `${GATEWAY}demo-2.0.0/_next/a.js`)?.mirror).toBe(NEW);
  });

  it("ignores the rest of the mirror host, the bare folder name and unknown refs", () => {
    expect(siteFor(snap, GATEWAY)).toBeUndefined();
    expect(siteFor(snap, `${GATEWAY}demo-2.0.0`)).toBeUndefined();
    expect(siteFor(snap, `${GATEWAY}demo-9.9.9/`)).toBeUndefined();
    expect(siteFor(snap, "https://mirror.example.org/other/")).toBeUndefined();
    expect(siteFor(snap, "about:blank")).toBeUndefined();
  });

  it("accepts an http gateway", () => {
    const http = snapshot("http://localhost:9000/", [NEW]);
    expect(siteFor(http, "http://localhost:9000/demo-2.0.0/index.html")?.mirror).toBe(NEW);
  });

  it.each(["TODO", "", "ftp://x/", "https://mirror.example.org/no-slash"])("skips recovery for gateway %j", (gateway) => {
    expect(siteFor(snapshot(gateway, [NEW]), `${gateway}demo-2.0.0/`)).toBeUndefined();
  });
});

describe("pathIn", () => {
  const site = { dapp: "demo", base: `${GATEWAY}demo-2.0.0/` };

  it("is the part after the ref, without query or fragment, decoded", () => {
    expect(pathIn(site, `${GATEWAY}demo-2.0.0/`)).toBe("/");
    expect(pathIn(site, `${GATEWAY}demo-2.0.0/_next/a%20b.js?v=1#x`)).toBe("/_next/a b.js");
  });

  it("is undefined outside the folder, including a sibling with the same prefix", () => {
    expect(pathIn(site, `${GATEWAY}demo-1.0.0/index.html`)).toBeUndefined();
    expect(pathIn(site, `${GATEWAY}demo-2.0.0x/index.html`)).toBeUndefined();
    expect(pathIn(site, "https://mirror.example.org/_next/a.js")).toBeUndefined();
    expect(pathIn(site, `${GATEWAY}demo-2.0.0/../demo-1.0.0/a.js`)).toBeUndefined();
  });

  it("is the whole path on a policy origin", () => {
    expect(pathIn({ dapp: "demo", base: `${ORIGIN}/` }, `${ORIGIN}/earn/`)).toBe("/earn/");
    expect(pathIn({ dapp: "demo", base: `${ORIGIN}/` }, "https://cdn.example.org/a.js")).toBeUndefined();
  });
});

describe("mirrorUrl", () => {
  it("follows gatewayUrl and allows http", () => {
    expect(mirrorUrl(GATEWAY, "demo-2.0.0", "/earn")).toBe(`${GATEWAY}demo-2.0.0/earn`);
    expect(mirrorUrl("http://localhost:9000/", "r", "/")).toBe("http://localhost:9000/r/");
    expect(() => mirrorUrl(GATEWAY, "../x", "/")).toThrow();
    expect(() => mirrorUrl(GATEWAY, "r", "/a/../b")).toThrow();
  });
});

describe("verifiedCopyUrl", () => {
  it("opens the locked release at the current path", () => {
    const snap = snapshot(GATEWAY, [NEW, OLD]);
    expect(verifiedCopyUrl(snap, "demo", OLD, "/earn")).toEqual({ url: `${GATEWAY}demo-1.0.0/earn` });
  });

  it("falls back to the newest release with a ref", () => {
    const snap = snapshot(GATEWAY, [BARE, NEW, OLD]);
    expect(verifiedCopyUrl(snap, "demo", undefined, "/")).toEqual({ url: `${GATEWAY}demo-2.0.0/` });
    expect(verifiedCopyUrl(snap, "demo", BARE, "/")).toEqual({ url: `${GATEWAY}demo-2.0.0/` });
  });

  it("returns an error without a gateway, a mirrored release or a dapp", () => {
    expect(verifiedCopyUrl(snapshot("TODO", [NEW]), "demo", NEW, "/")).toHaveProperty("error");
    expect(verifiedCopyUrl(snapshot(GATEWAY, [BARE]), "demo", undefined, "/")).toHaveProperty("error");
    expect(verifiedCopyUrl(snapshot(GATEWAY, [NEW]), undefined, undefined, "/")).toHaveProperty("error");
  });

  it("opens the release root when the current path can't be used", () => {
    const snap = snapshot(GATEWAY, [NEW]);
    expect(verifiedCopyUrl(snap, "demo", NEW, "/a//b")).toEqual({ url: `${GATEWAY}demo-2.0.0/` });
  });
});
