# Architecture

Working codename: `unforged`. Rename everywhere when the project name is chosen.

## What we are building

A browser extension that refuses to run a dapp's code unless independent builders rebuilt it from the public source and got the same bytes. Rebuilders publish signed attestations to Arkiv, and the verified build is mirrored on a static host as a recovery copy.

```
            public repo + recipe
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
 builder A        builder B       builder C        (CLI or GitHub Action, separate keys)
     │  manifest + signed attestation │
     └──────────────┬─────────────────┘
                    ▼
          Arkiv (Tiramisu testnet)  ◄── policy entity (curator)
                    │ bulk sync (no per-visit lookups)
                    ▼
 user's Firefox ── extension ── intercepts every response from a supported origin
                    │            hash → in an accepted release? → allow / BLOCK
                    ▼
            Mirror on any static host: verified build (recovery copy, diff source)
```

## Repo layout (pnpm workspace, TypeScript, Node 22+)

```
packages/core/        formats, canonical JSON, hashing, attestation sign/verify, policy evaluation (pure, no I/O)
packages/registry/    Arkiv read/write + mirror URLs (I/O lives here)
apps/cli/             rebuilder: recipe → build → manifest → attest → publish
apps/extension/       Firefox MV3 extension: sync, intercept, verify, block, UI
action/               GitHub Action (composite) wrapping apps/cli
recipes/              one YAML per supported dapp release
demo/                 local hosting server + attack scripts for the live demo
study/                reproducibility study scripts and results (from pre-event research)
docs/                 these specs
```

Rules that keep work parallel:
- `packages/core/src/types.ts` is the contract. It is written first (milestone M1) and frozen after review. Changing it needs all three members to agree.
- `core` has no I/O and no network, so it runs unchanged in Node (CLI) and in the extension background script.
- Every package exposes a small `index.ts`. Other packages import only from it.

## Components

| Component | Owner | Spec |
|---|---|---|
| core (formats, hashing, signatures, policy evaluation) | Arya | `docs/formats.md` |
| extension enforcement (intercept, verify, block, sync) | Arya | `docs/extension.md` |
| CLI rebuilder + recipes | Varun | `docs/cli-registry.md` |
| registry (Arkiv + mirror URLs) | Varun | `docs/cli-registry.md` |
| GitHub Action | Varun | `docs/cli-registry.md` |
| extension UI (badge, popup, blocked page, diff) | Yuvraaj | `docs/extension.md` §UI |
| demo server + attacks | Yuvraaj | `docs/demo.md` |

## Trust model in one paragraph

The extension ships with one hardcoded **curator address**. The curator publishes `policy` entities on Arkiv: which origins belong to which dapp, which builder addresses are allowed, and the threshold *k*. Builders publish `attestation` entities. The extension trusts an attestation only if (a) its Arkiv creator is an allowed builder, (b) the in-payload signature recovers to that same address, (c) the manifest in the payload hashes to the root that was signed, and (d) at least *k* distinct builders attested the same manifest root. A release accepted this way is 🟢 **Reproduced**. A release matched only by a vendor attestation is 🟡 **Vendor-attested** (stretch goal).

## Sponsor integration points

| Sponsor | Where | Requirement it satisfies |
|---|---|---|
| EF CROPS | whole product; README "CROPS" section | lead property: Secure, structural (works without the dapp team) |
| Arkiv Mirror | `packages/registry` writes, extension reads | re-runnable import (`unforged publish`), user-visible read (badge), schema + friction docs |
| ENSv2 (optional) | policy mirrored in ENS text records | only if M14 is reached |

## Out of scope for the hackathon

Chrome enforcement (stretch: detect-and-warn), wallet integrations, Sigstore keyless signing (we use Ethereum keys, so the builder's Arkiv creator address is its signing identity), production key management.
