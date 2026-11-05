import { describe, expect, it } from "vitest";
import { sha256Hex, type AcceptedRelease, type Manifest, type Policy } from "@unforged/core";
import lido from "../fixtures/lido-0.161.0.manifest.json";
import { decide, newTab, servedPath, type Snapshot } from "./decide.js";

const ORIGIN = "http://localhost:8080";
const enc = (s: string) => new TextEncoder().encode(s);
const hash = (s: string) => sha256Hex(enc(s));

const INDEX = "<html>genuine</html>";
const CHUNK = "console.log('genuine chunk')";
const OLD_CHUNK = "console.log('chunk from 0.160.0')";
const OLD_INDEX = "<html>0.160.0</html>";
const ENV_OK = 'window.__env__={"rpc":"https://rpc.example.org/x"}';
const ENV_BAD = 'window.__env__={"rpc":"https://evil.example.com/x"}';
const EVIL = "steal()";

const ENV_RULE = { kind: "window-env-json" as const, allowedKeys: ["rpc"], urlHostAllowlist: ["rpc.example.org"] };

async function release(name: string, files: Record<string, string>): Promise<AcceptedRelease> {
  const hashed: Record<string, string> = {};
  for (const [path, body] of Object.entries(files)) hashed[path] = await hash(body);
  const manifest: Manifest = {
    version: 1,
    dapp: "demo",
    release: name,
    commit: "c".repeat(40),
    files: hashed,
    config: { "/runtime/window-env.js": ENV_RULE },
  };
  return {
    dapp: "demo",
    release: name,
    commit: manifest.commit,
    manifestRoot: name.padEnd(64, "0"),
    manifest,
    builders: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
    builtAt: "2026-11-01T00:00:00Z",
    swarmRefs: [],
  };
}

async function snapshot(): Promise<Snapshot> {
  const policy: Policy = {
    dapp: "demo",
    origins: [ORIGIN],
    repo: "https://github.com/example/demo",
    builders: [],
    threshold: 2,
    acceptLatest: 3,
    thirdParty: { "https://cdn.example.org": { "/pinned.js": await hash("pinned()") } },
    recovery: { gateway: "TODO" },
  };
  const current = await release("2.0.0", { "/index.html": INDEX, "/app/chunk.js": CHUNK });
  const old = await release("1.0.0", { "/index.html": OLD_INDEX, "/app/chunk.js": OLD_CHUNK });
  return { syncedAt: "2026-11-05T00:00:00Z", dapps: { demo: { policy, releases: [current, old] } } };
}

function req(path: string, body: string, type = "script", origin = ORIGIN) {
  return { url: origin + path, type, tabOrigin: ORIGIN, body: enc(body) };
}

/** Loads the genuine document so the tab locks to release 2.0.0. */
async function lockedTab(snap: Snapshot) {
  const tab = newTab();
  const d = await decide(snap, tab, req("/", INDEX, "main_frame"));
  expect(d.allow).toBe(true);
  return tab;
}

describe("servedPath", () => {
  const files = lido.files as Record<string, string>;
  it("maps / and trailing slashes to index.html", () => {
    expect(servedPath(`${ORIGIN}/`, files)).toBe("/index.html");
    expect(servedPath(`${ORIGIN}/earn/`, files)).toBe("/earn/index.html");
  });
  it("maps an extensionless path to its index.html, ignoring query and hash", () => {
    expect(servedPath(`${ORIGIN}/earn?ref=x#top`, files)).toBe("/earn/index.html");
  });
  it("falls back to .html, then to the path itself", () => {
    expect(servedPath(`${ORIGIN}/404`, files)).toBe("/404/index.html");
    expect(servedPath(`${ORIGIN}/page`, { "/page.html": "x" })).toBe("/page.html");
    expect(servedPath(`${ORIGIN}/nothing`, files)).toBe("/nothing");
    expect(servedPath(`${ORIGIN}/_next/a.js?v=1`, files)).toBe("/_next/a.js");
  });
});

describe("decide", () => {
  it("allows the genuine index and chunk and reports reproduced", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    const d = await decide(snap, tab, req("/app/chunk.js", CHUNK));
    expect(d).toEqual({ allow: true });
    expect(tab.state).toMatchObject({ dapp: "demo", release: "2.0.0", checked: 2, blocked: [] });
    expect(tab.state.verdict).toEqual({
      level: "reproduced",
      dapp: "demo",
      release: "2.0.0",
      builders: snap.dapps.demo!.releases[0]!.builders,
    });
  });

  it("blocks a swapped chunk as hash-mismatch", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    const d = await decide(snap, tab, req("/app/chunk.js", EVIL));
    expect(d.allow).toBe(false);
    expect(d.blocked).toEqual({
      url: `${ORIGIN}/app/chunk.js`,
      reason: "hash-mismatch",
      expected: await hash(CHUNK),
      actual: await hash(EVIL),
    });
    expect(tab.state.verdict).toEqual({ level: "mismatch", dapp: "demo", blocked: [d.blocked] });
  });

  it("blocks an extra file as unknown-file", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    const d = await decide(snap, tab, req("/app/extra.js", EVIL));
    expect(d.blocked?.reason).toBe("unknown-file");
  });

  it("blocks an injected cross-origin script as third-party, allows a pinned one", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    const evil = await decide(snap, tab, req("/evil.js", EVIL, "script", "http://localhost:9090"));
    expect(evil.blocked?.reason).toBe("third-party");
    const pinned = await decide(snap, tab, req("/pinned.js", "pinned()", "script", "https://cdn.example.org"));
    expect(pinned).toEqual({ allow: true });
  });

  it("blocks a cloned index that is in no release as a tab mismatch", async () => {
    const snap = await snapshot();
    const tab = newTab();
    const d = await decide(snap, tab, req("/", "<html>clone</html>", "main_frame"));
    expect(d.allow).toBe(false);
    expect(d.blocked?.reason).toBe("hash-mismatch");
    expect(tab.state.verdict.level).toBe("mismatch");
    // Without a locked release nothing else on the tab is allowed.
    expect((await decide(snap, tab, req("/app/chunk.js", CHUNK))).allow).toBe(false);
  });

  it("blocks a file from another accepted release as release-mixed", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    const d = await decide(snap, tab, req("/app/chunk.js", OLD_CHUNK));
    expect(d.blocked?.reason).toBe("release-mixed");
  });

  it("checks config files and records accepted values", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    expect(await decide(snap, tab, req("/runtime/window-env.js", ENV_OK))).toEqual({ allow: true });
    expect(tab.state.configValues).toEqual({ rpc: "https://rpc.example.org/x" });
    const bad = await decide(snap, tab, req("/runtime/window-env.js", ENV_BAD));
    expect(bad.blocked?.reason).toBe("config-invalid");
  });

  it("resets the tab on a new top-level document", async () => {
    const snap = await snapshot();
    const tab = await lockedTab(snap);
    await decide(snap, tab, req("/app/chunk.js", EVIL));
    await decide(snap, tab, req("/", OLD_INDEX, "main_frame"));
    expect(tab.state).toMatchObject({ release: "1.0.0", checked: 1, blocked: [] });
  });

  it("fails closed when the tab origin has no policy", async () => {
    const snap = await snapshot();
    const d = await decide(snap, newTab(), { ...req("/", INDEX, "main_frame"), tabOrigin: "https://other.example" });
    expect(d.allow).toBe(false);
  });
});
