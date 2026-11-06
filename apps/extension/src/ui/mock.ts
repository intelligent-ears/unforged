// Built-in fixtures for ?mock=<level>, so every state can be viewed without a dapp.
// The addresses and hashes are made up.
import type { Blocked, TabState } from "@unforged/core";
import type { SyncSummary } from "../summary.js";
import type { Level } from "./format.js";

const DAPP = "lido-staking-widget";
const RELEASE = "0.161.0";
const BUILDERS = [
  "0x1234567890aBcDeF1234567890aBcDeF1234abcd",
  "0x5678901234aBcDeF5678901234aBcDeF56785e6f",
  "0x9abc567890aBcDeF9abc567890aBcDeF9abc7a8b",
];

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const ORIGIN = "https://stake.example.org";

const BLOCKED: Blocked[] = [
  {
    url: `${ORIGIN}/_next/static/chunks/main-43ad6ba73f167526.js`,
    reason: "hash-mismatch",
    expected: hash("8685f56b"),
    actual: hash("c0ffee12"),
  },
  { url: `${ORIGIN}/_next/static/chunks/extra.js`, reason: "unknown-file", actual: hash("77aa01bc") },
  { url: "http://localhost:9090/evil.js", reason: "third-party", actual: hash("d15ea5e0") },
  { url: `${ORIGIN}/runtime/window-env.js`, reason: "config-invalid", actual: hash("0a1b2c3d") },
  {
    url: `${ORIGIN}/_next/static/chunks/framework.js`,
    reason: "release-mixed",
    expected: hash("a3d1941f"),
    actual: hash("5ca1ab1e"),
  },
];

const CONFIG = {
  defaultChain: 560048,
  prefillUnsafeElRpcUrls560048: ["https://hoodi.drpc.org/v1/public"],
  rootOrigin: "https://stake.example.org",
  enableQaHelpers: false,
};

export const MOCK_STATES: Record<Level, TabState> = {
  reproduced: {
    dapp: DAPP,
    release: RELEASE,
    verdict: { level: "reproduced", dapp: DAPP, release: RELEASE, builders: BUILDERS.slice(0, 2) },
    checked: 42,
    blocked: [],
    configValues: CONFIG,
  },
  vendor: {
    dapp: DAPP,
    release: RELEASE,
    verdict: { level: "vendor", dapp: DAPP, release: RELEASE },
    checked: 42,
    blocked: [],
    configValues: CONFIG,
  },
  mismatch: {
    dapp: DAPP,
    release: RELEASE,
    verdict: { level: "mismatch", dapp: DAPP, blocked: BLOCKED },
    checked: 17,
    blocked: BLOCKED,
  },
  unsupported: { verdict: { level: "unsupported" }, checked: 0, blocked: [] },
};

export function mockSummary(now: number = Date.now()): SyncSummary {
  return {
    lastError: null,
    syncedAt: new Date(now - 3 * 60_000).toISOString(),
    dapps: [
      {
        dapp: DAPP,
        policyVersion: 1,
        buildersTotal: BUILDERS.length,
        threshold: 2,
        gateway: "https://gateway.example.org/bzz/",
        releases: [
          {
            release: RELEASE,
            commit: "e256fd6db9f713433b5b95bcf2d2fd833131a547",
            builders: BUILDERS.slice(0, 2),
            swarmRefs: [hash("b0a710ad")],
          },
        ],
      },
    ],
  };
}
