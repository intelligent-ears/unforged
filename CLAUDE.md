# Unforged

A Firefox extension that blocks a dapp's code unless independent builders rebuilt it from the public source and got the same bytes. Builders publish signed attestations to Arkiv (Rabdi testnet); the verified build is mirrored on Swarm.

Read only what your task names. Specs: `docs/architecture.md` (map), `docs/formats.md` (contract), `docs/extension.md`, `docs/cli-registry.md`, `docs/demo.md`, `docs/build-plan.md`.

## Layout
- `packages/core`: pure TS (no I/O, no network). Formats, canonical JSON, sha256, attestation verify, policy evaluation.
- `packages/registry`: Arkiv + Swarm I/O.
- `apps/cli`: `unforged build|attest|publish|policy|verify`.
- `apps/extension`: Firefox MV3 (background: sync + enforcement; UI: popup, blocked page).
- `action/`, `recipes/`, `demo/`, `study/`.

## Commands
- Package names: `@unforged/core`, `@unforged/registry`, `@unforged/cli`, `@unforged/extension`.
- `pnpm i`, `pnpm -r test` (vitest), `pnpm -r build`, `pnpm --filter @unforged/<name> test`
- Extension: `pnpm --filter @unforged/extension build`, then load `apps/extension/dist/manifest.json` via `about:debugging`.

## Hard rules
1. `packages/core/src/types.ts` is frozen after M1. If a change seems necessary, stop and say so; don't edit it.
2. `core` must not import from `registry`, Node built-ins, or browser APIs except `crypto.subtle`.
3. Never put a private key in code, tests, logs or fixtures. Keys come from env vars (`BUILDER_PRIVATE_KEY`, `CURATOR_PRIVATE_KEY`, `ARKIV_ACCESS_KEY`). Tests use viem's generated keys.
4. Transactions go only to testnets: Arkiv Rabdi (chain 7794095), and Sepolia for the optional ENS milestone. Never mainnet.
5. The extension never queries the registry because the user visited a site. Sync is periodic and bulk.
6. Fail closed: if verification can't complete, block and say why. Never silently allow.
7. One milestone per session. Don't start the next milestone.

## How to work
- Write the acceptance test first and run it red, then implement.
- Prefer small, readable functions; a judge may read this code.
- Before finishing: `pnpm --filter @unforged/<name> test` and `... build` pass for every package you touched.
- Commit small working steps with imperative messages. Do not add Co-Authored-By trailers. Never push; the author pushes.
- End every task with a summary of at most 8 lines: what changed, what's tested, anything left. Don't paste whole files back.
- Don't read `node_modules`, `dist`, `study/results` or lockfiles unless a specific error points there. Don't read `docs/prompts.md`; it's for the humans.
