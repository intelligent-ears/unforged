// Writes fixtures/snapshot.json: a hand-made sync snapshot (extension.md sync step 5) for the Lido demo.
// Bundled into background.js until M9 replaces it with the snapshot synced from Arkiv.
import { readFile, writeFile } from "node:fs/promises";
import { manifestRoot, sha256Hex } from "@unforged/core";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const EXPECTED_ROOT = "13c7535a8b18401f36f176ebc74488ed5929e494b8d4e15f6a68a1bee9d26682";
// The genuine demo config (ipfsMode:false). Pinned by the curator in the policy (formats.md §5).
const WINDOW_ENV = new URL("../../../demo/site/runtime/window-env.js", import.meta.url);
const EXPECTED_WINDOW_ENV = "1dc276f81fab369bcab6cd53b511e4090897b27501adae5b5b5cd9fd46489537";

// Placeholder addresses, not real builders. No keys exist for them.
const BUILDERS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];

const manifest = JSON.parse(await readFile(new URL("lido-0.161.0.manifest.json", FIXTURES), "utf8"));
const root = await manifestRoot(manifest);
if (root !== EXPECTED_ROOT) {
  console.error(`manifest root ${root} != expected ${EXPECTED_ROOT}`);
  process.exit(1);
}

const windowEnv = await sha256Hex(new Uint8Array(await readFile(WINDOW_ENV)));
if (windowEnv !== EXPECTED_WINDOW_ENV) {
  console.error(`window-env.js hash ${windowEnv} != expected ${EXPECTED_WINDOW_ENV}`);
  process.exit(1);
}

const policy = {
  dapp: manifest.dapp,
  origins: ["http://localhost:8080"],
  repo: "https://github.com/lidofinance/ethereum-staking-widget",
  builders: BUILDERS,
  threshold: 2,
  acceptLatest: 3,
  thirdParty: {},
  recovery: { gateway: "TODO" },
  configPins: { "/runtime/window-env.js": windowEnv },
};

const release = {
  dapp: manifest.dapp,
  release: manifest.release,
  commit: manifest.commit,
  manifestRoot: root,
  manifest,
  builders: BUILDERS.slice(0, 2),
  builtAt: "2026-11-01T00:00:00Z",
  swarmRefs: [],
};

const snapshot = {
  syncedAt: new Date().toISOString(),
  dapps: { [manifest.dapp]: { policy, releases: [release] } },
};

await writeFile(new URL("snapshot.json", FIXTURES), JSON.stringify(snapshot) + "\n");
console.log(`wrote fixtures/snapshot.json (root ${root})`);
