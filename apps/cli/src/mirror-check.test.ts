import { createHash } from "node:crypto";
import type { ConfigRule, Manifest } from "@unforged/core";
import { describe, expect, it, vi } from "vitest";
import { checkMirror, formatMirrorReport } from "./mirror-check.js";

const GATEWAY = "https://mirror.example/";
const REF = "demo-1.0.0";
const url = (path: string) => `${GATEWAY}${REF}${path}`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const RULE: ConfigRule = { kind: "window-env-json", allowedKeys: [] };

function manifestOf(bodies: Record<string, string>, config: string[] = []): Manifest {
  return {
    version: 1,
    dapp: "demo",
    release: "1.0.0",
    commit: "a".repeat(40),
    files: Object.fromEntries(Object.entries(bodies).map(([path, body]) => [path, sha256(body)])),
    config: Object.fromEntries(config.map((path) => [path, RULE])),
  };
}

/** A host serving these bodies at the ref's folder; anything else is a 404. */
function host(bodies: Record<string, string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const body = Object.entries(bodies).find(([path]) => url(path) === String(input))?.[1];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  });
}

const BODIES = { "/index.html": "<html>", "/a.js": "a()" };

describe("checkMirror", () => {
  it("passes when every file matches", async () => {
    const fetch = host(BODIES);
    const report = await checkMirror(manifestOf(BODIES), GATEWAY, REF, { fetch });
    expect(report).toEqual({ matched: 2, total: 2, problems: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports one mismatch with both hashes", async () => {
    const report = await checkMirror(manifestOf(BODIES), GATEWAY, REF, { fetch: host({ ...BODIES, "/a.js": "evil()" }) });
    expect(report.matched).toBe(1);
    expect(report.total).toBe(2);
    expect(report.problems).toEqual([{ path: "/a.js", problem: `hash mismatch: expected ${sha256("a()")}, got ${sha256("evil()")}` }]);
  });

  it("reports one 404", async () => {
    const report = await checkMirror(manifestOf(BODIES), GATEWAY, REF, { fetch: host({ "/index.html": "<html>" }) });
    expect(report.matched).toBe(1);
    expect(report.problems).toEqual([{ path: "/a.js", problem: "HTTP 404" }]);
  });

  it("only needs a config path to exist, whatever its bytes", async () => {
    const config = "/runtime/window-env.js";
    const report = await checkMirror(manifestOf(BODIES, [config]), GATEWAY, REF, { fetch: host({ ...BODIES, [config]: "anything" }) });
    expect(report).toEqual({ matched: 3, total: 3, problems: [] });
  });

  it("fails on a missing config path", async () => {
    const config = "/runtime/window-env.js";
    const report = await checkMirror(manifestOf(BODIES, [config]), GATEWAY, REF, { fetch: host(BODIES) });
    expect(report.matched).toBe(2);
    expect(report.problems).toEqual([{ path: config, problem: "HTTP 404" }]);
  });

  it("only accepts status 200", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const report = await checkMirror(manifestOf({ "/a.js": "" }), GATEWAY, REF, { fetch });
    expect(report.problems).toEqual([{ path: "/a.js", problem: "HTTP 204" }]);
  });

  it("retries once on a network error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response("a()"));
    const report = await checkMirror(manifestOf({ "/a.js": "a()" }), GATEWAY, REF, { fetch });
    expect(report.problems).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries when the body fails partway, not only the request", async () => {
    const broken = new Response("x");
    vi.spyOn(broken, "arrayBuffer").mockRejectedValue(new TypeError("terminated"));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(broken).mockResolvedValueOnce(new Response("a()"));
    const report = await checkMirror(manifestOf({ "/a.js": "a()" }), GATEWAY, REF, { fetch });
    expect(report.problems).toEqual([]);
  });

  it("reports a network error after the retry, with no third try", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    const report = await checkMirror(manifestOf({ "/a.js": "a()" }), GATEWAY, REF, { fetch });
    expect(report.matched).toBe(0);
    expect(report.problems).toEqual([{ path: "/a.js", problem: "fetch failed (ENOTFOUND)" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP error", async () => {
    const fetch = host({});
    await checkMirror(manifestOf({ "/a.js": "a()" }), GATEWAY, REF, { fetch });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("gives every request a timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const report = await checkMirror(manifestOf({ "/a.js": "a()" }), GATEWAY, REF, { fetch, timeoutMs: 5 });
    expect(report.problems).toEqual([{ path: "/a.js", problem: "fetch failed (TimeoutError)" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("runs at most 8 requests at once", async () => {
    const bodies = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/${i}.js`, `${i}`]));
    let running = 0;
    let peak = 0;
    const serve = host(bodies);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return serve(input);
    });
    const report = await checkMirror(manifestOf(bodies), GATEWAY, REF, { fetch });
    expect(report.matched).toBe(30);
    expect(peak).toBe(8);
  });

  it("counts a path that can't form a URL as a problem, without fetching it", async () => {
    const fetch = host(BODIES);
    const report = await checkMirror(manifestOf({ ...BODIES, "/../x.js": "x" }), GATEWAY, REF, { fetch });
    expect(report.matched).toBe(2);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.path).toBe("/../x.js");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a manifest with no files", async () => {
    const report = await checkMirror(manifestOf({}), GATEWAY, REF, { fetch: host({}) });
    expect(report.total).toBe(0);
    expect(report.problems).toEqual([{ path: "(manifest)", problem: "lists no files" }]);
  });

  it.each([
    ["an invalid gateway", "http://mirror.example/", REF],
    ["an invalid ref", GATEWAY, "../up"],
    ['the reserved ref "none", which reads back as no mirror', GATEWAY, "none"],
    ["a ref too long for an Arkiv string attribute", GATEWAY, "a".repeat(129)],
  ])("refuses %s before any request, with the bad-input exit code", async (_, gateway, ref) => {
    const fetch = host(BODIES);
    await expect(checkMirror(manifestOf(BODIES), gateway, ref, { fetch })).rejects.toMatchObject({ exitCode: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("formatMirrorReport", () => {
  const problems = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/${i}.js`, problem: "HTTP 404" }));

  it("prints N/total match and nothing else when clean", () => {
    expect(formatMirrorReport({ matched: 2, total: 2, problems: [] })).toBe("2/2 match");
  });

  it("prints at most 20 problems and says how many it left out", () => {
    const lines = formatMirrorReport({ matched: 5, total: 30, problems: problems(25) }).split("\n");
    expect(lines[0]).toBe("5/30 match");
    expect(lines[1]).toBe("  /0.js: HTTP 404");
    expect(lines).toHaveLength(22);
    expect(lines[21]).toBe("  ...and 5 more");
  });
});
