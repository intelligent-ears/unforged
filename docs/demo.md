# Demo environment (owner: Yuvraaj)

## Goal

Replay real front-end attacks against the **real Lido staking widget** (release 0.161.0, built from source by our independent builders) on a testnet, in front of judges, in under 3 minutes.

## Setup

**Before a demo, free port 8080.** Steam listens on `127.0.0.1:8080` on at least one of our machines, and the demo server can't start (or the browser reaches Steam instead). Quit Steam, then check with `ss -ltnp | grep :8080`.

- `demo/site/` — the Lido build output (`out/`) produced by `unforged build`. Serve the exact `out/` of a builder whose `manifestRoot` is the one the attestations agree on, and check that the badge is green before recording. In 2 of 12 of our Lido builds, `_buildManifest.js` came out in a second, equivalent form with two variable names swapped, which has a different hash. Built with real public testnet RPC URLs in the recipe's `env`. Config is data, so builders get identical code files.
- `demo/server.mjs` — Node static server on `http://localhost:8080` (the origin in the demo policy). It reads `demo/state.json` on every request to decide which mode to serve.
- `demo/attacker.mjs` — second server on `http://localhost:9090` serving `evil.js`.
- `demo/attack.mjs <mode>` — writes `demo/state.json`. Modes:

| Mode | What it does | Mirrors |
|---|---|---|
| `reset` | serve the genuine build | normal day |
| `swap` | serve a tampered copy of one JS chunk (the one loaded on the stake page) | Bybit (one file swapped in S3) |
| `inject` | serve `index.html` with an extra `<script src="http://localhost:9090/evil.js">` | BadgerDAO, KyberSwap (injected third-party script) |
| `hijack` | serve every file from `demo/clone/` (a copy with a modified bundle) | Curve, Aerodrome, CoW Swap (DNS hijack to a cloned site) |

## The malicious payload (identical for all modes)

A small self-contained IIFE that wraps `request` on `window.ethereum` and on every EIP-6963
provider (it listens for `eip6963:announceProvider` and asks providers to announce). For
`eth_sendTransaction` it replaces `to` with the attacker address — a [Hoodi](https://github.com/eth-clients/hoodi)
address the team controls (`0x24080c83E2cbD50507ec5fE8480DDa14227f6a90`, public, no key in the
repo). Without the extension the wallet pops up with the attacker's address: the "transaction
swapped before signing" pattern from Bybit.

**The guard (why this is safe to ship in the repo).** The payload rewrites `to` only when BOTH
hold: the page origin equals `config.origin` (`http://localhost:8080`) AND the wallet reports
chain `config.chainId` (560048 = Hoodi, which it reads with `eth_chainId` before deciding).
On any other site or network — and for any method other than `eth_sendTransaction` — every call
passes through untouched. So the committed payload is inert against real Lido and real mainnet;
it only bites the local demo. Each rewrite logs one line: `[unforged demo payload] to <orig> -> <attacker>`.
**In the demo we always REJECT the transaction in the wallet; we never confirm it.**

**Generating it.** The guard values live in [`demo/config.json`](../demo/config.json) and are
baked into [`demo/attacker/payload.template.js`](../demo/attacker/payload.template.js) at
generation time (no runtime fetch). Regenerate everything with:

```
node demo/tools/make-attacks.mjs /_next/static/chunks/framework-b338f11e54b60304.js
```

Pass the JS chunk to tamper — pick it from the browser's network tab on the stake page, one
that loads before Stake is clicked. The tool writes `demo/attacker/evil.js` (the payload),
`demo/tampered/<chunk>` (genuine bytes + payload), and `demo/clone/` (a copy of the site with
that chunk replaced), and prints the sha256 of the genuine and tampered chunk. It is
deterministic: run it twice, get the same bytes. It refuses if `demo/site` is empty or the
chunk doesn't exist, and validates the attacker address with viem.

## Demo script (3 minutes)

| Time | Action | Shows |
|---|---|---|
| 0:00 | "21 Feb 2025: Bybit lost \$1.5B. Safe's GitHub was clean; one file on the server wasn't." | the problem |
| 0:20 | Extension **off**, `attack swap`, click Stake: the wallet shows the attacker's address | the attack works |
| 0:45 | `attack reset`, extension **on**: badge 🟢, popup shows "release 0.161.0, 2 of 2 builders" | normal day |
| 1:05 | `attack swap`, reload: badge 🔴, blocked page, diff shows the injected lines | caught before it runs |
| 1:35 | "Open verified copy": mirror copy loads, 🟢, stake works | recovery |
| 1:55 | `attack hijack`: blocked instantly | DNS hijack |
| 2:10 | Arkiv explorer: two attestation entities from different builders, same `manifest_root`. Mirror reference | proof is public |
| 2:30 | Study slide: 4 of 7 buildable dapps reproducible as published, the other 3 with small fixes | it's real, today |
| 2:50 | Close: "With this installed, Bybit's signers would have seen a red screen." | |

## Live on Arkiv Rabdi

The Lido policy ([`demo/policy.json`](../demo/policy.json)) requires 2 of 2 builders. Both have attested the same build:

| What | Who | Entity / tx |
|---|---|---|
| Policy v1 | curator [`0x60422cB6937125250f829ed2d06B02AE2679dE09`](https://rabdi.explorer.arkiv.network/address/0x60422cB6937125250f829ed2d06B02AE2679dE09) | [`0x68842c8d…0fbfae66`](https://rabdi.explorer.arkiv.network/entity/0x68842c8d4e3b756f717ec4175307b43c2bdfa121550f8bc4587dc13d0fbfae66) |
| Attestation 1 | builder 1, Docker [`0x723eE223ffAEEe90312E158E11FE75763262C5D3`](https://rabdi.explorer.arkiv.network/address/0x723eE223ffAEEe90312E158E11FE75763262C5D3) | [`0xaa51c3cc…ae7ef90d`](https://rabdi.explorer.arkiv.network/entity/0xaa51c3cc9f5f63838b7a55afd4a8f84980637dc8f411458883b9e323ae7ef90d) |
| Attestation 2 | builder 2, GitHub Action [`0x9125c7F8A2001c3f0C902f4eEAEFC414Db339ACD`](https://rabdi.explorer.arkiv.network/address/0x9125c7F8A2001c3f0C902f4eEAEFC414Db339ACD) | [`0xd3782c81…621c1b25`](https://rabdi.explorer.arkiv.network/entity/0xd3782c8131b21e334e252c65b9293b4bec3c8848b9b4b29ea0cccddf621c1b25) ([tx](https://rabdi.explorer.arkiv.network/tx/0x02249a35548dbd834dce5cdcf55b2375687941a7c4ad6f5d2f14a458192c65ed)) |

Both attestations carry `manifest_root` `13c7535a8b18401f36f176ebc74488ed5929e494b8d4e15f6a68a1bee9d26682`.

## Second site: Minder docs

[`recipes/minder-docs@ff32f48.yaml`](../recipes/minder-docs@ff32f48.yaml) rebuilds Minder's Docusaurus docs (https://docs.mindersec.dev) from commit `ff32f48`, the source of gh-pages commit `f9fe4ab`. All 434 files match that deploy byte for byte (gh-pages also has `CNAME`, which isn't part of the build). Manifest root: `2032cd1fa4ef696df07994713020ba6402033057b64ada9530d9ca6ad754b81a`.

It's served locally, not at docs.mindersec.dev, because Minder redeploys several times a day and each deploy changes about 159 of the 434 files. The live site would soon be a release nobody attested, but the local copy always stays green. The policy is [`demo/policy-minder-docs.json`](../demo/policy-minder-docs.json) (origin `http://localhost:8081`, 2 of 2 builders). It records no mirror ref, so "Open verified copy" doesn't show.

```sh
git -C <minder clone> fetch origin gh-pages     # needs f9fe4ab locally
mkdir -p <dir> && git -C <minder clone> archive f9fe4ab | tar -x -C <dir>
node demo/tools/serve-static.mjs <dir> --port 8081
```

`serve-static` serves clean URLs the way GitHub Pages does: `/dir/` serves `index.html`, `/page` serves `page.html`, and any other path gets `404.html` with status 404.

## Pre-recorded backup

Record the full flow once it works (by hour 30). If the venue Wi-Fi or the testnet fails during judging, play the recording and run what still works locally. The Arkiv snapshot means verification itself works offline.
