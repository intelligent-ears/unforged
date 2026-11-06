# Unforged

A Firefox extension that blocks a dapp's code unless independent builders rebuilt it from the public source and got the same bytes.

In February 2025, one tampered JavaScript file on Safe{Wallet}'s hosting cost Bybit about $1.5B. Safe's GitHub repository was clean the whole time: the attack existed only in the gap between the public source and the bytes the server sent. Unforged closes that gap. Builders who don't work for the dapp rebuild each release from its public repo, sign the result and publish it to [Arkiv](https://arkiv.network). The extension hashes every script, page and stylesheet before it runs, and blocks anything that *k* of those builders didn't produce. When a site is blocked, it offers a verified copy of the real release from a mirror.

No cooperation from the dapp is needed. Anyone can protect the users of an open-source dapp by rebuilding it.

- [Website](http://intelears.me/unforged/) · [Architecture](docs/architecture.md) · [Formats](docs/formats.md) · [Extension](docs/extension.md) · [CLI and registry](docs/cli-registry.md) · [Threat model](docs/threat-model.md) · [Demo](docs/demo.md)
- Arkiv: [schema](arkiv/schema.md) · [how we use it](arkiv/how-you-use-arkiv.md) · [why Arkiv](arkiv/why-arkiv.md) · [reach](arkiv/reach.md) · [friction log](arkiv/friction.md)
- [Reproducibility study](study/README.md): 13 dapp frontends, which ones rebuild byte for byte, and why the rest don't

## Status

Live on Arkiv's Rabdi testnet: the Lido staking widget 0.161.0, rebuilt independently by two builders that got the same 170 files. One built in Docker on a team member's machine, the other in a GitHub Actions run with its own key. The curator's signed policy requires 2 of 2. The extension syncs this from Arkiv and turns the real build green, and blocks a swapped file, an injected script, a cloned site and a flipped config value. Entity keys and transactions are in [docs/demo.md](docs/demo.md#live-on-arkiv-rabdi).

What the popup shows for the genuine build:

> 🟢 **Reproduced** · lido-staking-widget 0.161.0 · commit e256fd6 · **2 of 2 builders** (0x723e…C5D3, 0x9125…9ACD) · 10 files checked · accepted config values

## Run it

You need Node 22 or 24, pnpm (`corepack enable`) and Firefox 128 or later.

```sh
pnpm i && pnpm -r build && pnpm -r test
```

**The extension.** In Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `apps/extension/dist/manifest.json`. It syncs policies and attestations from Arkiv on install and every 10 minutes, keyless, over the public Rabdi RPC. The popup's **Sync now** syncs immediately.

**The demo dapp.** The demo policy covers `http://localhost:8080`. Build Lido with the recipe (needs about 8 GB of RAM; see [Independent builders](#independent-builders)), then serve it:

```sh
node demo/tools/use-build.mjs /unforged/build/out   # copy a build into demo/site
node demo/server.mjs                                 # the dapp on http://localhost:8080
node demo/attacker.mjs                               # the attacker's server on :9090
node demo/attack.mjs swap --target <chunk path>      # or inject, hijack, reset
```

Without a real build in `demo/site`, the server serves the tiny fixtures in `demo/fixtures`, and the extension needs the fixture build (`pnpm --filter @unforged/extension build:fixture`) to know them. Quit anything else on port 8080 first (Steam listens there).

**Check the live data yourself.** This runs the same keyless reads and checks as the extension, and prints the accepted release:

```sh
node packages/registry/scripts/query-live.mjs lido-staking-widget
```

## Arkiv

Unforged's registry lives on Arkiv's Rabdi testnet (chain 7794095). Every entity is readonly and written through `@arkiv-network/sdk` 1.0. The extension reads it directly, with no server of ours in between.

| Role | Address | Writes |
|---|---|---|
| Curator | [`0x60422cB6937125250f829ed2d06B02AE2679dE09`](https://rabdi.explorer.arkiv.network/address/0x60422cB6937125250f829ed2d06B02AE2679dE09) | signed `policy` entities |
| Builder 1 (Docker) | [`0x723eE223ffAEEe90312E158E11FE75763262C5D3`](https://rabdi.explorer.arkiv.network/address/0x723eE223ffAEEe90312E158E11FE75763262C5D3) | `attestation` entities |
| Builder 2 (GitHub Action) | [`0x9125c7F8A2001c3f0C902f4eEAEFC414Db339ACD`](https://rabdi.explorer.arkiv.network/address/0x9125c7F8A2001c3f0C902f4eEAEFC414Db339ACD) | `attestation` entities |

**One query you can run.** Every attestation for Lido. After `pnpm i`, save it as `packages/registry/q.mjs` (so the SDK resolves) and run `node packages/registry/q.mjs`:

```js
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { eq } from "@arkiv-network/sdk/query";
import { http } from "viem";

const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
const { entities } = await client
  .select({ $key: true, $creator: true, release: true, manifest_root: true, swarm_ref: true })
  .where([eq("project", "unforged"), eq("entity_type", "attestation"), eq("dapp", "lido-staking-widget")])
  .limit(100)
  .fetch();
console.log(entities);
```

Both builders' entities come back with the same `manifest_root`, `13c7535a8b18401f36f176ebc74488ed5929e494b8d4e15f6a68a1bee9d26682`. The full version, with the policy's signature check and the k-of-n decision, is [`packages/registry/scripts/query-live.mjs`](packages/registry/scripts/query-live.mjs).

The import is `unforged publish`, re-runnable by anyone with a funded key (below). Entities, fields, owners and lifetimes are in [arkiv/schema.md](arkiv/schema.md).

## Independent builders

A builder rebuilds a dapp from its public source and signs what it got. There are two ways to do it, and both run the same CLI commands.

**On your own machine.** You need Node at the recipe's version, and write access to the recipe's `buildPath` (`/unforged/build` here). After `pnpm i && pnpm -r build`, with `BUILDER_PRIVATE_KEY` and `ARKIV_ACCESS_KEY` set in your environment or a git-ignored `.env`, run:

```sh
R=recipes/lido-staking-widget@0.161.0.yaml; node apps/cli/dist/cli.js build "$R" && node apps/cli/dist/cli.js attest manifest.json "$R" && node apps/cli/dist/cli.js publish attestation.json manifest.json
```

**On GitHub, in your own organisation.** Fork this repo, add your key as the `BUILDER_PRIVATE_KEY` secret and your [Rabdi access key](https://hub.arkiv.network/access-keys) as `ARKIV_ACCESS_KEY`, then run the **Independent builder** workflow from the Actions tab. Fund the key's address with test GLM from the [Hub faucet](https://hub.arkiv.network/faucet) first. Without `ARKIV_ACCESS_KEY` the run still builds and attests, then fails at `publish`; the signed `attestation.json` is in the run's artifacts.

Set `expected-root` to the root other builders got, and the run stops before signing a build that differs. If the only difference is `_buildManifest.js`, a [known nondeterminism](docs/cli-registry.md), run it again.

Independence comes from who holds the key, not from the tool. A dapp team's own CI only ever counts as a vendor attestation, even when it runs this same workflow.

## Verified mirror

When the extension blocks a site, **Open verified copy** loads the attested release from a mirror instead: [`http://intelears.me/unforged-mirror/lido-0.161.0/`](http://intelears.me/unforged-mirror/lido-0.161.0/). The mirror is any static host and is not trusted. The extension hashes every file it serves against the same attested manifest, so a changed file is blocked there too, and plain HTTP costs privacy, not integrity. The CLI refuses to record a mirror reference unless every file on it matches (`unforged mirror-check`). The mirrored build carries the source repository's `LICENSE` and a `SOURCE.md` pointing at the exact commit.

## CROPS

Unforged's lead property is **S**ecure, and it's structural: protection doesn't depend on the dapp team, its servers, its DNS or its keys.

- **C: censorship resistance.** We control three things the user depends on. The curator key decides which builders count: if we stop publishing, existing policies keep working until their entities expire (about 182 days), but no new dapps or builders get added. The mirror host: if it goes away, only the recovery copy is lost; blocking still works. The extension's distribution: if it's pulled, installed copies keep working. Arkiv RPC: if it's unreachable, the extension keeps its last synced snapshot and fails closed on anything new. An RPC that hides newer entities can make the extension use an older signed policy; see the [threat model](docs/threat-model.md#gaps-outside-this-ranking). Anyone can become a builder without asking us. Only whether they count is up to the curator.
- **O: open source.** MIT. Everything builds and runs from this repo: the extension, the CLI, the GitHub Action, the demo and the study. Builders reproduce dapps from the dapp's own public source, with a recipe that is a plain YAML file here.
- **P: privacy.** Browsing never triggers a network request of ours. The extension syncs every policy and attestation in bulk every 10 minutes and checks pages locally, so the Arkiv RPC learns your IP address and that you run Unforged, but not which dapps you open. The mirror host learns your IP and the dapp only after a block: the blocked page fetches the genuine file from it to show the diff, and **Open verified copy** loads the release from it. There are no analytics or trackers. An optional Arkiv access key, if you set one in the options page, stays in the extension's local storage.
- **S: security.** The extension holds no user keys and never touches the wallet; it decides which code may run before that code can build a transaction. Builder and curator keys live in git-ignored `.env` files or GitHub secrets and only sign testnet data. A release counts only when *k* allowlisted builders signed the same manifest root, each signature matches the entity's creator, and the manifest rehashes to that root. Policies are signed by the curator, so Arkiv is untrusted storage. Trust assumptions: the curator key is held only by the curator, fewer than *k* builders collude, and the browser and the extension itself aren't compromised. Ranked weaknesses are in [docs/threat-model.md](docs/threat-model.md).

## Reproducibility study

Before the event we tried to rebuild 13 widely used open-source dapp frontends. Of the 7 that build without network access beyond package registries, 4 were byte-for-byte reproducible as published (Lido, ENS, Curve, Safe Transaction Builder: 2,381 files, zero differences), and the other 3 (Uniswap, Aave, Snapshot) became reproducible with small fixes we tested. Details, scripts and caveats are in [study/README.md](study/README.md).

## How we used AI

We used Anthropic's Claude throughout, and every change was reviewed by a team member before it was merged.

- **Code:** Claude Code wrote most of the code from milestone prompts we wrote ([docs/prompts.md](docs/prompts.md)) against specs we wrote first ([docs/](docs/)). Each milestone was test-first, and we ran the tests, the builds and every attack ourselves.
- **Planning and research:** we used Claude for the design, the threat model, the reproducibility study's scripts and analysis, and reviewing pull requests.
- **Writing:** Claude drafted the docs, including this README, from our notes and the code.
- **Keys:** no AI tool ever held or saw a private key. A person ran every command that signs or publishes.

## License

[MIT](LICENSE). Dapp builds on the mirror keep their own licenses, copied next to them.
