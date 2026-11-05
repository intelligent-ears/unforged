# CLI rebuilder, registry and GitHub Action (owner: Varun)

## CLI: `unforged`

| Command | Does |
|---|---|
| `unforged build <recipe.yaml>` | Clone `repo` at `commit` (shallow) into `recipe.buildPath`, write `files`, write `env` to `envFile`, run `install` then `build` using the pinned Node, then hash `output` into a Manifest (config files go to `manifest.config`, not `files`). Writes `manifest.json` and `build-info.json` (`{ manifestRoot, node, packageManager, os, builtAt }`, from the first build with `--check`) and prints `manifestRoot` |
| `unforged attest <manifest.json> <recipe.yaml> [--toolchain-from-host]` | Build the Statement, sign the digest with `BUILDER_PRIVATE_KEY` (env var, never logged), write `attestation.json`. `toolchain.node`, `toolchain.os` and `builtAt` come from the `build-info.json` beside the manifest. Refuses if it describes another manifest, or if it is missing unless `--toolchain-from-host` records the current machine and time instead |
| `unforged publish <attestation.json> <manifest.json> [--out-dir <dir>]` | Optionally upload `out-dir` to Swarm (gets `swarm_ref`), then create the Arkiv `attestation` entity. Idempotent: if an entity with the same `manifest_root` already exists for this creator, print it and exit 0 |
| `unforged policy <policy.json>` | Curator only. Create a `policy` entity with `version = previous + 1` |
| `unforged verify <url>` | Debug helper: fetch a live site's files listed in the accepted manifest and report matches. Not used by the extension |

Pinned Node: the CLI checks `node --version` against `recipe.node` and refuses to build on a mismatch, unless `--allow-node-mismatch` is given (recorded in `predicate.toolchain`).

Exit codes: 0 ok, 2 build failed, 3 nondeterminism detected (`--check` builds twice and compares), 4 registry error.

Known nondeterminism: Lido's Next.js 12 build sometimes writes `_buildManifest.js` with two minified parameter names swapped (2 of 12 builds in our study). The code is equivalent but the hash differs. If `--check` reports only that file, rebuild. With 3 builders and threshold 2, at least two always agree, because there are only two forms.

## Registry package (`packages/registry`)

Two entry points, because the extension bundles this package and must not pull in Node code:
- `@unforged/registry` (browser-safe, used by the extension and CLI): Arkiv functions + `gatewayUrl`.
- `@unforged/registry/swarm` (Node only, used by the CLI): `uploadDir`.

```ts
// Arkiv (SDK @arkiv-network/sdk ~1.0.1, chain: rabdi, id 7794095)
createReadClient(accessKey = ""): keyless by default, which is what the extension uses
createWriteClient(account, accessKey)
rabdiPrepare(account, accessKey): Prepare // explicit nonce, gas and gasPrice for each write
publishAttestation(walletClient, payload: { attestation, manifest }, attrs, prepare?): Promise<{ entityKey, txHash }>
publishPolicy(walletClient, policy, version, prepare?): Promise<{ entityKey, txHash }>
// Reads take `source`: a client, or { accessKey? }. No key or "" means the public RPC. All retry HTTP 429 (see below).
findAttestationKey(source, creator, manifestRoot): Promise<entityKey | null> // publish's idempotency check
fetchPolicies(source, curator): Promise<{ version: number; policy: Policy }[]> // highest version first
fetchAttestations(source, builder, dapp, skipKeys?: Set<string>): Promise<{ entityKey, creator, attestation, manifest, swarmRef }[]>
  // lists keys + attributes first, then fetches payloads only for keys not in skipKeys (incremental sync)
gatewayUrl(gateway, ref, path): string
// Swarm (@ethersphere/bee-js), Node only
uploadDir(beeUrl, batchId, dir): Promise<string /* swarm ref */>
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
- Swarm: `new Bee(url).uploadFilesFromDirectory(batchId, dir, { indexDocument: "index.html" })` returns `reference.toHex()`. Needs a Bee node with a postage batch. Get the event setup from Swarm's team (pre-event task).

## GitHub Action (`action/action.yml`, composite)

Inputs: `recipe` (path), `arkiv-rpc` (optional), `bee-url`, `postage-batch` (optional). Secret: `BUILDER_PRIVATE_KEY`. Steps: setup-node with `recipe.node` → `unforged build` → `unforged attest` → `unforged publish`. Outputs `manifest-root`, `entity-key`, `swarm-ref`.

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
