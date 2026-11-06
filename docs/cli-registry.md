# CLI rebuilder, registry and GitHub Action (owner: Varun)

## CLI: `unforged`

| Command | Does |
|---|---|
| `unforged build <recipe.yaml>` | Clone `repo` at `commit` (shallow) into `recipe.buildPath`, write `files`, write `env` to `envFile`, run `install` then `build` using the pinned Node, then hash `output` into a Manifest (config files go to `manifest.config`, not `files`). Writes `manifest.json` and `build-info.json` (`{ manifestRoot, node, packageManager, os, builtAt }`, from the first build with `--check`) and prints `manifestRoot` |
| `unforged attest <manifest.json> <recipe.yaml> [--toolchain-from-host]` | Build the Statement, sign the digest with `BUILDER_PRIVATE_KEY` (env var, never logged), write `attestation.json`. `toolchain.node`, `toolchain.os` and `builtAt` come from the `build-info.json` beside the manifest. Refuses if it describes another manifest, or if it is missing unless `--toolchain-from-host` records the current machine and time instead |
| `unforged mirror-check <manifest.json> --gateway <url> --ref <name>` | Fetch every path in `manifest.files` through `gatewayUrl`, hash each body, and print `N/total match` plus up to 20 mismatches or fetch errors. Paths in `manifest.config` only need to answer 200, because their bytes are pinned in the policy. Exit 0 if all match, 3 otherwise. 8 requests at once, 30s timeout per file, one retry on a network error |
| `unforged publish <attestation.json> <manifest.json> [--mirror-ref <name> --gateway <url>]` | Create the Arkiv `attestation` entity. With a mirror, run the mirror check first and refuse (exit 3) unless it passes, then store the ref in `swarm_ref`. Without one, `swarm_ref` is `none`. Idempotent: if an entity with the same `manifest_root` already exists for this creator, print it and exit 0. That entity is readonly, so a ref it doesn't already hold is not recorded, and publish warns on stderr |
| `unforged policy <policy.json>` | Curator only. Pick `version = previous + 1`, sign the policy and that version with `CURATOR_PRIVATE_KEY` (formats.md §4 `SignedPolicy`), verify the encoded payload, then create the `policy` entity |
| `unforged verify <url>` | Debug helper: fetch a live site's files listed in the accepted manifest and report matches. Not used by the extension |

Pinned Node: the CLI checks `node --version` against `recipe.node` and refuses to build on a mismatch, unless `--allow-node-mismatch` is given (recorded in `predicate.toolchain`).

Exit codes: 0 ok, 1 input refused, 2 build failed, 3 nondeterminism detected (`--check` builds twice and compares) or a mirror that doesn't match, 4 registry error.

Known nondeterminism: Lido's Next.js 12 build sometimes writes `_buildManifest.js` with two minified parameter names swapped (2 of 12 builds in our study). The code is equivalent but the hash differs. If `--check` reports only that file, rebuild. With 3 builders and threshold 2, at least two always agree, because there are only two forms.

## Registry package (`packages/registry`)

One browser-safe entry point, `@unforged/registry`, used by the extension and CLI: Arkiv functions + `gatewayUrl`. The extension bundles it, so it must not pull in Node code.

```ts
// Arkiv (SDK @arkiv-network/sdk ~1.0.1, chain: rabdi, id 7794095)
createReadClient(accessKey = ""): keyless by default, which is what the extension uses
createWriteClient(account, accessKey)
rabdiPrepare(account, accessKey): Prepare // explicit nonce, gas and gasPrice for each write
publishAttestation(walletClient, payload: { attestation, manifest }, attrs, prepare?): Promise<{ entityKey, txHash }>
publishPolicy(walletClient, signed: SignedPolicy, prepare?) // version attribute = signed.version: Promise<{ entityKey, txHash }>
// Reads take `source`: a client, or { accessKey? }. No key or "" means the public RPC. All retry HTTP 429 (see below).
findAttestation(source, creator, manifestRoot): Promise<{ entityKey, swarmRef } | null> // publish's idempotency check
fetchPolicies(source, curator): Promise<{ version: number; policy: Policy }[]> // highest version first; only rows whose $creator is the curator and whose signature verifies (verifyPolicy) and whose signed version equals the version attribute
fetchAttestations(source, builder, dapp, skipKeys?: Set<string>): Promise<{ entityKey, creator, attestation, manifest, swarmRef }[]>
  // lists keys + attributes first, then fetches payloads only for keys not in skipKeys (incremental sync)
// Mirrors. gateway: http or https URL ending in "/". ref: [a-z0-9][a-z0-9.-]*. path: starts with "/".
// Returns gateway + ref + path. Throws on anything that could leave the ref's folder.
gatewayUrl(gateway, ref, path): string
```
Gzip with `fflate` (works in both Node and the browser).
SDK facts that save research time:
- Clients: `rabdi({ accessKey })` from `@arkiv-network/sdk/chains` and `http()` from viem. The key is a path segment of the RPC URL, and viem quotes that URL in errors, so never log a raw transport error. The CLI reads the key from `ARKIV_ACCESS_KEY` and `apps/cli/src/registry.ts` strips URLs and the key from anything it prints. An access key neither signs nor pays gas.
- Keyless reads: `rabdi({ accessKey: "" })` uses the public endpoint, which is "heavily rate limited" and can answer HTTP 429. Arkiv publishes no number for it. The extension always reads this way. Each read request retries a 429 with exponential backoff (0.5s, 1s, 2s, 4s, 8s, or the server's `Retry-After`, capped at 60s), then throws, and the extension must treat that as a failed sync, never as an empty result. With a key: 100,000,000 quota units per key; each `arkiv_query` costs 10, other calls (including `arkiv_getEntity`) cost zero under current provider policy.
- Write: `walletClient.createEntity(schema, values, { expiration: ExpirationTime.max(), flags: { readonly: true, permissionlessExtension: false } }, txParams)`. It returns `{ entityKey, txHash, expiresAt }` and throws if the receipt reverted. `fromDays(365)` is rejected: the maximum lifetime is about 182 days. Longer retention needs `extendEntity` before expiry, which the owner can still do on a readonly entity.
- Transaction parameters: `rabdiPrepare` estimates the exact write through a wallet that can't sign or send, then uses `gas = max(1,000,000, 2 x estimate)`, the latest nonce and the current gas price, refusing if a transaction is pending, the gas is over half the block limit, or the balance can't cover it. Arkiv measured default estimation reverting from gas exhaustion on Rabdi. Writes are not retried; after a failure, check the explorer first.
- Read: `publicClient.select({ $key: true, $creationFlags: true, swarm_ref: true }).where([eq("project","unforged"), eq("entity_type","attestation"), eq("dapp", d)]).createdBy(addr).orderBy(asc("$key")).limit(100).fetch()`. Rows are flat and each value is `{ type, value }`. Bytes values are hex. `arkiv_getEntity` (`client.getEntity(key)`) returns everything under `$attributes`.
- Pages hold at most 100 and there is no cursor, `hasNextPage()` or `next()`. Walk by keyset: add `gt("$key", key(last))` until a page comes back short. Selecting without `from(schema)` means a malformed entity can't hide the rest of a page. A multi-page walk is not one snapshot.
- Only `.indexed()` columns can be filtered, per column, and readonly entities can't gain an index later.
- Imports: `createPublicClient, createWalletClient, ExpirationTime` from `@arkiv-network/sdk`; `asc, eq, gt` from `@arkiv-network/sdk/query`; `rabdi` from `@arkiv-network/sdk/chains`; `defineSchema, bytes, key, str, u64` from `@arkiv-network/sdk/schema`.
- Limits: bytes ≤128 KiB per create, string attribute ≤128 bytes, ≤32 attributes. Gas is paid in test GLM (Hub faucet); access keys come from the Hub.
- Explorer: `https://rabdi.explorer.arkiv.network`.
- Network resets can invalidate entity keys without changing the chain ID, so republish rather than assume a key survives.
- Install Arkiv's agent skills for Claude Code before starting: `npx skills add https://github.com/arkiv-network/skills`.

## Verified mirror

A recovery copy of an attested build can live on any static host; we use GitHub Pages. `swarm_ref` and `swarmRefs` hold a mirror reference (any static host; verified byte-for-byte), field name kept for compatibility. It is a folder name on the policy's `recovery.gateway`, e.g. `https://intelligent-ears.github.io/unforged-mirror/`. The host is untrusted: the CLI won't attest a mirror that doesn't match, and the extension re-verifies every byte. The mirror may be plain HTTP: every byte is verified against the attested manifest, so transport security adds privacy, not integrity.

1. `scripts/publish-mirror.sh <out-dir> <ref> <manifest.json>` verifies `out-dir` against the manifest and refuses on a changed, missing or unlisted file. It then commits the build to `<ref>/` on the `gh-pages` branch of `intelligent-ears/unforged-mirror`, with `<ref>/LICENSE` (from the source repo's pinned commit), `<ref>/SOURCE.md` and a root `.nojekyll`, so that Pages serves `_next/`. It never pushes: it prints the command for a human to run. It needs a built CLI. `UNFORGED_RECIPE`, `UNFORGED_MIRROR_DIR` and `UNFORGED_MIRROR_REMOTE` override the recipe (default `recipes/<dapp>@<release>.yaml`), clone location and remote.
2. Once Pages has deployed: `unforged mirror-check manifest.json --gateway https://intelligent-ears.github.io/unforged-mirror/ --ref <ref>`.
3. `unforged publish attestation.json manifest.json --mirror-ref <ref> --gateway https://intelligent-ears.github.io/unforged-mirror/`.

Publish the attestation with its ref the first time: entities are readonly, so one already published with `none` can't gain a ref. A ref can't be `none`, which reads back as no mirror, or longer than 128 bytes.

## GitHub Action (`action/action.yml`, composite)

Inputs: `recipe` (path), `arkiv-rpc` (optional), `mirror-ref`, `gateway` (optional). Secret: `BUILDER_PRIVATE_KEY`. Steps: setup-node with `recipe.node` → `unforged build` → `unforged attest` → `unforged publish`. Outputs `manifest-root`, `entity-key`, `mirror-ref`.

Independence rule (README): builders run this Action in **their own** GitHub organisations with their own keys. The dapp team's own CI produces at most a vendor attestation, never an independent one.

## Supported dapps for the demo

| Dapp | Release | Status from our study |
|---|---|---|
| Lido staking widget | 0.161.0 (`e256fd6`) | 170/170 identical. **Demo target** |
| ENS app | pin a commit at the event | 1,380/1,380 identical |
| Curve | pin a commit at the event | 810/810 identical |
| Uniswap web | main at `bdbace6` (22 Oct); pin a `web/*` release tag at the event | 1,457/1,457 identical with one recipe patch (`files` overrides `tsconfig.json` to drop 6 references to unpublished projects, see `study/harness/uni_patch.py`). Node exactly 22.23.4, Bun |
| Aave | pin a release tag | identical at a fixed `buildPath`, but only with a `generateBuildId` patch, so its live site can't match until Aave adopts that line |
| Safe{Wallet} | latest `web-v*` tag | needs a 16 GB machine. Vendor-attested only (stretch) |
