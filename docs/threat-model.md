# Threat model

What Unforged protects, who it protects against, what it relies on, and where it is weakest. It describes the design in `architecture.md`, `formats.md` and `extension.md`.

**Status on `main`:** M9 has merged. The extension syncs policies and attestations from Arkiv every 10 minutes, the curator address is hardcoded (`apps/extension/src/config.ts`), and recovery-mirror files are verified like the dapp's own. These are running code. The bundled snapshot exists only in `UNFORGED_FIXTURE=1` demo builds.

## Assets

1. **Users' funds, through the transactions they sign.** A dapp's code decides what the wallet is asked to sign. If that code is replaced, a user can approve a transaction that sends funds to an attacker, and the wallet prompt is built by the attacker's code.
2. **The integrity of the served dapp code.** The code running in the user's browser should be the code that the public source produces.

Unforged does not inspect transactions. It only checks that the code asking for them is the code that was reproduced.

## Adversaries

### Hosting, DNS or CDN attacker

Can serve any bytes from a dapp's origin. This is the main case Unforged is built for.

- **Stopped:** a changed document, script, stylesheet or frame is hashed before it reaches the page and blocked if it isn't in an accepted release. Extra cross-origin scripts are blocked unless pinned in the policy. Serving an old release is limited by `acceptLatest`, and mixing files from two releases gives `release-mixed`.
- **Not stopped:**
  - Taking the site down. The user can still open the mirror copy.
  - Changing non-code responses such as JSON API calls and images, which pass through unchecked. A dapp that trusts its API for addresses or calldata stays exposed.
  - Lookalike domains. The extension only acts on origins listed in a policy.

### Malicious build dependency

- **Stopped:** a package that reaches only some builders, or changes its output between builds. Their manifest roots differ, so the bad root doesn't reach *k* attestations unless at least *k* builders get the same bad bytes.
- **Not stopped:** a malicious package pinned in the lockfile. Every builder reproduces it faithfully and the release goes green. See "Out of scope" below.

### Compromised builder

Holds one allowlisted builder key and can sign attestations for any bytes.

- **Stopped:** fewer than *k* such builders can't get a release accepted, because *k* distinct allowlisted builders must sign the same root. The curator can remove a builder in a new policy version.
- **Not stopped:** *k* or more colluding or compromised builders can get any bytes accepted. They can also push genuine releases out of the `acceptLatest` window by attesting newer ones.

### Compromised curator key

The policy decides which origins, builders, threshold, third-party pins, config pins and mirror apply. Whoever holds this key can list their own builders with `threshold: 1` and turn an attacker's code green. They can also delist builders to block a dapp.

Nothing in the extension limits this. Rotating the key is not enough, because the address is hardcoded and the attacker can keep publishing higher policy versions with the old key. Recovery needs an extension update.

### Compromised mirror

Can change or remove the files it hosts. Every byte is verified against the attested manifest, so changed files are blocked, even over plain HTTP. It can still withhold the recovery copy and can see who requests it. The mirror only matters when a user asks for the verified copy or opens the diff panel.

### Malicious extension update

The extension can read and rewrite every response on every site (`<all_urls>`, `webRequestBlocking`, `webRequestFilterResponse`). A malicious version could turn off the checks or attack any site, including ones Unforged doesn't cover. Nothing inside the extension can defend against this.

## Trust assumptions

If any of these fails, the guarantee fails.

1. **The curator key is held only by the curator.**
2. **Fewer than *k* of the allowlisted builders collude or are compromised at once.** Builders running the same software are not fully independent (weakness 3).
3. **The browser is not compromised.** The extension runs inside it and relies on its request interception and storage.

## Weaknesses, lowest bar first

Ranked by how little an attacker needs to exploit each one.

| # | Weakness | Current mitigation | Next step |
|---|---|---|---|
| 1 | **The curator key is a single hot key in a `.env` file.** Stealing one file gives full control of the policy. Recovery after compromise needs an extension update. | The key comes only from an env var, `.env*` is gitignored, errors never print the value, and writes go only to testnets. | Move to a hardware wallet, then to k-of-n curators. |
| 2 | **Extension install and update channel (AMO account).** Whoever controls the account can ship a new version to every user, with no builder involved. | Mozilla's signing and review, which do not prove the package matches this repo. Nothing in Unforged checks it. | Write a reproducible extension recipe and have builders attest it. Users would check this outside the extension, since a bad version can't be trusted to check itself. |
| 3 | **Builders share one CLI implementation.** A bug or backdoor in the CLI gives every builder the same wrong root, so the *k* check passes. | Builders use separate keys and machines. Attestations record Node, package manager and OS, but not the version of the tool itself. | Write an independent Python root calculator and record the tool version in attestations. |
| 4 | **Config values.** Config files are not reproduced from source, and values that look valid can still be hostile, such as a flipped `ipfsMode`. | **Done:** pinned by the curator. A config file must match `policy.configPins` and pass `checkConfig`, and any change needs a new policy version. The remaining risk is weakness 1. | None planned. |
| 5 | **Out of scope:** attacks on the source or lockfile, and a compromised browser or OS. | None. A reproduced release shows the code matches its source, not that the source is safe. | None planned. |

## Gaps outside this ranking

These came up while writing this document and are not ranked above.

- **A stale snapshot keeps working.** This is deliberate, so verdicts survive going offline, but the spec sets no maximum age. If sync is blocked, a removed builder or a revoked release stays accepted for that user.
- **A malicious RPC can still withhold or roll back policies.** Signatures stop forged policies, not missing ones. The `version` attribute is outside the signature, so an RPC that hides newer entities, or relabels an older signed policy with a higher version, can serve a superseded policy the curator really signed. A dapp whose every policy is withheld simply isn't listed, so its origins are not checked.
- **Some code may not be checked.** Only code request types and `xmlhttprequest` paths ending in `.js` are filtered (`classify.ts`), so WebAssembly or scripts fetched from other paths pass through. Requests with no tab (`tabId` -1) are also not filtered, and these may include service worker scripts. Service worker cases are on the hardening list and not yet tested.

## Fixed

- **Policies are not signed in their payload.** *Fixed.* A policy payload is now `{ policy, signature }`, where `signature` is the curator's EIP-191 signature over `sha256(canonicalJSON(policy))` (formats.md §4, `verifyPolicy` in `packages/core/src/signed-policy.ts`). `fetchPolicies` drops a row unless the signature recovers to the configured curator and the entity's `$creator` is that same address, so unsigned, mis-signed or tampered payloads are ignored and Arkiv is untrusted storage. `unforged policy` signs with `CURATOR_PRIVATE_KEY` and verifies its own encoded payload before sending. Policies published in the old unsigned format are no longer read and must be republished. The Policy type in `types.ts` is unchanged.
