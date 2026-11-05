# Demo environment (owner: Yuvraaj)

## Goal

Replay real front-end attacks against the **real Lido staking widget** (release 0.161.0, built from source by our three builders) on a testnet, in front of judges, in under 3 minutes.

## Setup

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

A small script that wraps `window.ethereum.request` and, for `eth_sendTransaction`, replaces `to` with `ATTACKER_ADDRESS` (a testnet address we control). Generic and visible: without the extension, the wallet pops up with the attacker's address. That's the "transaction swapped before signing" pattern from Bybit.

## Demo script (3 minutes)

| Time | Action | Shows |
|---|---|---|
| 0:00 | "21 Feb 2025: Bybit lost \$1.5B. Safe's GitHub was clean; one file on the server wasn't." | the problem |
| 0:20 | Extension **off**, `attack swap`, click Stake: the wallet shows the attacker's address | the attack works |
| 0:45 | `attack reset`, extension **on**: badge 🟢, popup shows "release 0.161.0, verified by 3 independent builders" | normal day |
| 1:05 | `attack swap`, reload: badge 🔴, blocked page, diff shows the injected lines | caught before it runs |
| 1:35 | "Open verified copy": mirror copy loads, 🟢, stake works | recovery |
| 1:55 | `attack hijack`: blocked instantly | DNS hijack |
| 2:10 | Arkiv explorer: three attestation entities, same `manifest_root`. Mirror reference | proof is public |
| 2:30 | Study slide: 3 of 5 buildable dapps reproducible out of the box | it's real, today |
| 2:50 | Close: "With this installed, Bybit's signers would have seen a red screen." | |

## Pre-recorded backup

Record the full flow once it works (by hour 30). If the venue Wi-Fi or the testnet fails during judging, play the recording and run what still works locally. The Arkiv snapshot means verification itself works offline.
