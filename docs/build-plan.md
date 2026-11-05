# 36-hour build plan and team split

**Roles**
- **Arya: engine and security.** `packages/core`, extension enforcement, integration, threat-model Q&A.
- **Varun: chain and data.** CLI rebuilder, recipes, Arkiv, verified mirror, GitHub Action, optional ENS.
- **Yuvraaj: product and story.** Extension UI, demo environment, README and sponsor docs, deck, video.

Each milestone has one owner, one Claude Code prompt (`docs/prompts.md`, same number) and one acceptance test. A milestone is done only when its test passes and the work is committed.

## Timeline

| Hours | Arya | Varun | Yuvraaj |
|---|---|---|---|
| H0–1 | **M0** repo scaffold, push docs + CLAUDE.md | toolchain check (Node 22/24, pnpm, yarn), fund builder wallets | testnet wallet, Firefox dev profile |
| H1–4 | **M1** core formats + crypto | **M2** CLI `build` + manifest (Lido) | **M3** demo server + attack modes (any static site first) |
| H4–10 | **M4** extension: intercept + hash + log | M2 cont. → **M6** `attest` + Arkiv publish/read + policy | **M7** UI: badge, popup, blocked page (mocked state) |
| H10–16 | **M5** extension: verify + block (local snapshot fixture) | M6 cont. → **M8** verified mirror + gateway URLs | M7 cont. → **M10** diff panel |
| H16–20 | **M9** sync from Arkiv + recovery origin | 3 builders publish Lido attestations (one via Action in a separate org) | **M11** malicious payload + wallet flow on testnet |
| **H20** | **Integration checkpoint: full demo flow end to end, all three together** | | |
| H20–26 | hardening: acceptance tests 1–6, cache/service-worker edge cases | **M12** GitHub Action | **M13** README: CROPS section, Arkiv schema/friction, mirror section, AI disclosure |
| H26–30 | optional **M15** Chrome detect mode | optional **M14** ENS policy records | deck v1, study slide |
| **H30** | **Feature freeze. Record the backup demo video** | | |
| H30–33 | fix only freeze-blocking bugs; rehearse Q&A | ENS/Action polish only if green | video edit (Arya reviews), deck v2 |
| H33–35 | submission: showcase page, prize selection, final README check | | |
| H35–36 | buffer | | |

## Milestones and acceptance tests

| # | Owner | Milestone | Acceptance test |
|---|---|---|---|
| M0 | Arya | Repo scaffold | `pnpm i && pnpm -r test` passes on an empty test in every package |
| M1 | Arya | Core: canonical JSON, sha256, manifest root, statement, verify, acceptReleases, checkFile, checkConfig | Unit tests: a known vector for canonicalJSON; sign with a viem test key and verify; threshold 2-of-3 accepts, 1-of-3 rejects; config rule rejects an extra key and a non-allowlisted host |
| M2 | Varun | CLI `build` | Lido recipe builds; `--check` produces the same `manifestRoot` twice; 169 entries in `files` plus `/runtime/window-env.js` in `config` |
| M3 | Yuvraaj | Demo server | `node demo/attack.mjs swap` then `curl` shows the tampered chunk; `reset` restores it |
| M4 | Arya | Extension intercepts and hashes | Firefox console logs `{url, sha256}` for every script on `localhost:8080`; page still works |
| M5 | Arya | Verify + block from a fixture snapshot | Acceptance tests 1–4 in `extension.md` pass with the snapshot loaded from a JSON fixture |
| M6 | Varun | Attest + Arkiv | 3 attestation entities on Tiramisu from 3 keys; `fetchAttestations` returns them; explorer links in the README |
| M7 | Yuvraaj | UI shell | Popup and blocked page render all four verdict levels from mocked `TabState` |
| M8 | Varun | Verified mirror | Lido `out/` on GitHub Pages; `unforged mirror-check` passes; `gatewayUrl(gateway, ref, "/index.html")` opens; ref stored in the attestation |
| M9 | Arya | Sync + recovery | Fresh profile → sync → 🟢 without any fixture; "Open verified copy" loads from the mirror and verifies |
| M10 | Yuvraaj | Diff panel | Blocked page shows a readable diff of the swapped chunk, injected lines highlighted |
| M11 | Yuvraaj | Payload + wallet | Extension off: the wallet prompt shows `ATTACKER_ADDRESS`. Extension on: the page is blocked before the prompt |
| M12 | Varun | GitHub Action | Workflow run in a second GitHub org publishes a valid attestation |
| M13 | Yuvraaj | Sponsor docs | README has CROPS, Arkiv (wallets + one query), mirror (openable ref) and AI-use sections; `/arkiv/schema.md`, `/arkiv/friction.md` exist |
| M14 | Varun | ENS (optional) | Policy text records on Sepolia; a delegated key can set only the builder-list record |
| M15 | Arya | Chrome detect (optional) | On Chrome, a swapped chunk shows a red warning and holds `eth_sendTransaction` |

## Cut list (drop from the top when behind)

1. M15 Chrome detect mode
2. M14 ENS
3. M12 GitHub Action (keep the CLI; mention the Action as the next step)
4. Diff pretty-printing (show the raw diff)
5. Vendor-attested (🟡) level

Never cut: M1, M2, M5, M6, M9, M11, M13 and the backup video. Those are the demo, the Arkiv prize and the CROPS prize.

## Commit rhythm

Small commits per working step, imperative messages ("Hash responses in filterResponseData"). No single giant commit at the end: 1inch, Arkiv and ETHGlobal all check commit history.

## Before kickoff (29 Oct – 4 Nov)

Spikes go in **throwaway repos**, not the project repo.

| Who | Task | Due |
|---|---|---|
| Arya | Lido: rebuild 0.161.0 locally and compare with the official release CID (Lido's documented steps) | 29 Oct |
| Arya | Firefox spike: a tiny extension that hashes one page's JS with `filterResponseData` and blocks a modified file | 30 Oct |
| Arya | Pick the project name | 30 Oct |
| Varun | Arkiv: get GLM from the Hub faucet, write and read one test entity on Tiramisu | 30 Oct |
| Varun | Safe{Wallet}: build twice on a 16 GB+ machine and compare | 1 Nov |
| Varun | Create and fund 3 builder wallets + 1 curator wallet on Tiramisu | 2 Nov |
| Yuvraaj | Pick the demo testnet (one the Lido widget supports) and list public RPC URLs for the recipe's `env`; testnet wallet with testnet ETH; Firefox dev profile | 31 Oct |
| Yuvraaj | Ask ETHGlobal what they require when AI coding tools are used (disclosure, boilerplate rules) | 31 Oct |
| Yuvraaj | Reserve the GitHub org, npm scope and .eth name once the name is picked | 1 Nov |
| Yuvraaj | Demo storyboard from `demo.md`; deck skeleton (problem, incidents, study, demo, design, ask) | 2 Nov |
| Yuvraaj | Screen-recording setup for the backup video | 2 Nov |
| All | Register for the event (each member applies; closes 3 Nov) and confirm the hacking days | 2 Nov |
| All | 30-minute walkthrough of docs + prompts; agree on `types.ts` | 3 Nov |
