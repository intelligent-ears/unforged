# Reach

## Who is it for, and would they use it?

**People who sign transactions through dapp frontends.** The 17 front-end incidents we reviewed from 2021 to 2026 add up to $1.63B in reported losses. The 8 that hit open-source frontends account for $1.622B of that (99.8%), and each one served code that a rebuild from the public source would not have produced (our incident review: [`study/coverage.py`](../study/coverage.py)). The users at risk are the ones who'd use this, and the highest-value ones (treasury signers, DAO multisigs, exchanges' cold-wallet operators) have the most reason to. Bybit's signers approved a $1.5B transfer through a tampered page; the tampered file was exactly what Unforged blocks, though rebuilding Safe{Wallet} itself is still unmeasured (it needs more memory than our study machine had).

They don't need to understand any of this to use it: install the extension, and a supported dapp is either green or replaced by a page that says it was blocked and offers the genuine copy.

**Independent builders.** Security firms, auditors, wallet teams and community members who want to vouch for a frontend. A builder needs a key, a few minutes of CI per release and a little test GLM. From our measured build times, we estimate about 65 CPU-hours a year to rebuild every release of five major dapps.

**Dapp teams.** Nothing is required of them, but a reproducible build lets others protect their users. 4 of the 7 dapps we could build were reproducible as published; the other 3 needed one-line or one-file fixes.

## Can they try it today?

Yes:

- **The extension** builds from this repo and loads into Firefox in a minute ([README](../README.md#run-it)). It reads the live policy and attestations from Rabdi with no account or key.
- **The data** is live: a signed policy and two independent attestations for Lido 0.161.0, the same 170-file build reproduced in Docker and on GitHub Actions ([entity keys](../docs/demo.md#live-on-arkiv-rabdi)). `node packages/registry/scripts/query-live.mjs` shows it.
- **Becoming a builder** is a fork and a workflow run ([README](../README.md#independent-builders)).

What's not there yet: dapps beyond Lido, and Chrome, which can't read response bodies under Manifest V3.

## Will we keep building after Mumbai?


Next steps, in order:

1. Recipes for the other reproducible dapps from our study (ENS, Curve, Safe's Transaction Builder) and attestations from builders outside our team.
2. Moving the curator key to a hardware wallet, then to k-of-n curators.
3. A reproducible build of the extension itself, attested the same way.
4. Upstream fixes for the dapps that are one line away from reproducible (Aave's build ID, Snapshot's config).
5. Talking to wallet teams about refusing signatures from pages that fail verification, which would protect users who never install an extension.
