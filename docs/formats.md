# Formats (the contract)

Everything here lives in `packages/core`. All hashes are lowercase hex SHA-256. All signed or hashed JSON uses **canonical JSON**: object keys sorted lexicographically at every level, no whitespace, UTF-8, numbers as integers only.

## 1. Recipe (`recipes/<dapp>@<release>.yaml`)

Pins everything a rebuild depends on besides the source.

| Field | Type | Example (Lido) |
|---|---|---|
| `dapp` | string, `[a-z0-9-]+` | `lido-staking-widget` |
| `release` | string | `0.161.0` |
| `repo` | https URL | `https://github.com/lidofinance/ethereum-staking-widget` |
| `commit` | 40-hex | `e256fd6db9f713433b5b95bcf2d2fd833131a547` |
| `node` | major version string | `"24"` |
| `packageManager` | string, as in package.json | `yarn@4.17.1` |
| `files` | map path → literal content written before install | `build-info.json` with the real commit |
| `env` | map of **public** build config values | origins, RPC URLs, chain list |
| `envFile` | file the `env` map is written to before build | `.env.production.local` |
| `buildPath` | absolute path the repo is checked out to and built at. Every builder uses the same one, because some bundlers let the path change the output (Aave's chunks regroup when it moves) | `/unforged/build` |
| `install` | shell command | `yarn install --immutable` |
| `build` | shell command | `yarn build:ipfs` |
| `output` | dir relative to repo root | `out` |
| `configFiles` | map of served path → config-file rule (§5) | `{"/runtime/window-env.js": {kind: "window-env-json", ...}}` |

`recipeDigest = sha256(canonicalJSON(recipe))`.

## 2. Manifest

```ts
interface Manifest {
  version: 1;
  dapp: string;
  release: string;
  commit: string;
  files: Record<string, string>;   // "/index.html" -> sha256 hex. Paths start with "/". Same shape as WEBCAT's `files`.
  config: Record<string, ConfigRule>; // config files checked as data instead of by hash (§5). Not listed in `files`.
}
```
`manifestRoot = sha256(canonicalJSON(manifest))`.

Measured sizes: Lido 170 files (~19 KB JSON). ENS 1,380 files (~140 KB), which is why payloads are gzipped (§4).

## 3. Attestation (in-toto Statement v1)

```ts
interface Statement {
  _type: "https://in-toto.io/Statement/v1";
  subject: [{ name: string /* "<dapp>@<release>" */; digest: { sha256: string /* manifestRoot */ } }];
  predicateType: "https://unforged.dev/rebuild/v1";
  predicate: {
    repo: string; commit: string; recipeDigest: string;
    builder: `0x${string}`;          // checksummed address
    builtAt: string;                 // ISO 8601
    toolchain: { node: string; packageManager: string; os: string };
  };
}
interface SignedAttestation {
  statement: Statement;
  signature: `0x${string}`;          // EIP-191 personal_sign over the 32-byte digest sha256(canonicalJSON(statement)), signed as raw bytes
}
```
Verification: recover the signer from `signature` and the digest. It must equal `predicate.builder` **and** the Arkiv entity's `$creator`.

## 4. Arkiv entities (Rabdi, chain 7794095, SDK `@arkiv-network/sdk` ~1.0.1)

All entities: `project = "unforged"` (str, indexed), created `readonly`, `expiration = ExpirationTime.max()`. Rabdi caps a lifetime at 7,884,000 blocks (about 182 days from inclusion) and SDK 1.0.1 rejects anything longer before sending. Written through unnamed schemas, so there is no `arkiv.schema` attribute. SDK 1.0 has no opaque entity body: the payload is a named `bytes` column, and its media type is a `str` column.

**attestation** (created by a builder)

| Attribute | Type | Indexed | Value |
|---|---|---|---|
| `entity_type` | str | yes | `attestation` |
| `dapp` | str | yes | `lido-staking-widget` |
| `release` | str | yes | `0.161.0` |
| `commit` | str | yes | 40-hex |
| `manifest_root` | str | yes | 64-hex |
| `recipe_digest` | str | no | 64-hex |
| `swarm_ref` | str | no | 64-hex, or `none` |
| `content_type` | str | no | `application/gzip` |
| `payload` | bytes | no | `gzip(canonicalJSON({ attestation: SignedAttestation, manifest: Manifest }))` |

`payload` must stay under 120 KB after gzip. If larger, store the manifest on Swarm and put only `{attestation, manifestSwarmRef}` in it.

**policy** (created by the curator)

| Attribute | Type | Indexed | Value |
|---|---|---|---|
| `entity_type` | str | yes | `policy` |
| `dapp` | str | yes | `lido-staking-widget` |
| `version` | u64 | yes | increasing; the extension uses the highest |
| `content_type` | str | no | `application/gzip` |
| `payload` | bytes | no | gzip of the canonical JSON below |

Payload:
```ts
interface Policy {
  dapp: string;
  origins: string[];                 // e.g. ["http://localhost:8080"] for the demo
  repo: string;
  builders: `0x${string}`[];         // allowlisted builder addresses
  threshold: number;                 // k
  acceptLatest: number;              // accept only the newest m attested releases (downgrade protection)
  thirdParty: Record<string /*origin*/, Record<string /*path*/, string /*sha256*/>>; // pinned external scripts; anything else is blocked
  recovery: { gateway: string };     // Swarm gateway base, e.g. "https://<gateway>/bzz/"
}
```

Reads are always scoped with `.createdBy(address)`, and entities that aren't `readonly` are dropped, because a non-readonly entity can be edited after a transfer. `project` and `entity_type` are namespaces anyone can write, not authentication.

## 5. Config files (configuration as data)

Some files carry build-time configuration, not code. Lido's `/runtime/window-env.js` is exactly `window.__env__=` followed by one JSON object.

```ts
interface ConfigRule {
  kind: "window-env-json";           // the only kind for the hackathon
  allowedKeys: string[];             // any other key -> mismatch
  urlHostAllowlist?: string[];       // every string value that parses as a URL must use one of these hosts: host (with port), exact, case-insensitive
}
```
A config file passes if it parses exactly, has only allowed keys, contains only JSON primitives or arrays of primitives, and every URL host is allowlisted. The extension shows the accepted values in the popup.

## 6. Verdicts and UI state (extension)

```ts
type Verdict =
  | { level: "reproduced"; dapp: string; release: string; builders: string[] }
  | { level: "vendor";     dapp: string; release: string }               // stretch
  | { level: "mismatch";   dapp: string; blocked: Blocked[] }
  | { level: "unsupported" };
interface Blocked { url: string; reason: "unknown-file" | "hash-mismatch" | "third-party" | "config-invalid" | "release-mixed"; expected?: string; actual: string }

interface AcceptedRelease {
  dapp: string; release: string; commit: string;
  manifestRoot: string;
  manifest: Manifest;
  builders: `0x${string}`[];         // allowlisted builders who signed this exact root
  builtAt: string;                   // newest builtAt among them
  swarmRefs: string[];               // from the attestations' swarm_ref attributes ("none" dropped)
}

interface TabState {                 // what the UI reads via getTabState
  dapp?: string;
  release?: string;
  verdict: Verdict;
  checked: number;                   // files verified in this tab
  blocked: Blocked[];
  configValues?: Record<string, unknown>; // accepted config values, shown in the popup
}

interface SnapshotSummary {          // what the UI reads via getSnapshotSummary
  syncedAt: string | null;
  dapps: { dapp: string; policyVersion: number; buildersTotal: number; threshold: number;
           gateway: string; releases: { release: string; commit: string; builders: string[]; swarmRefs: string[] }[] }[];
}
```

## 7. Core API (implemented in M1, frozen afterwards)

```ts
canonicalJSON(value): string
sha256Hex(bytes: Uint8Array): Promise<string>                     // WebCrypto, works in Node 20+ and Firefox
manifestRoot(m: Manifest): Promise<string>
buildStatement(m: Manifest, recipe: Recipe, builder, toolchain): Promise<Statement>
statementDigest(s: Statement): Promise<`0x${string}`>
verifyAttestation(a: SignedAttestation, expectedCreator): Promise<boolean>   // viem recoverMessageAddress
acceptReleases(policy, entries: { creator, attestation, manifest, swarmRef }[]): Promise<AcceptedRelease[]>
  // drops an entry unless: creator is in policy.builders, verifyAttestation passes,
  // manifestRoot(manifest) == statement.subject[0].digest.sha256, manifest.dapp == policy.dapp,
  // predicate.repo == policy.repo. Then: >= threshold distinct builders on the same root; keep the newest acceptLatest.
checkFile(release, path, sha256): "ok" | "unknown-file" | "hash-mismatch"
checkConfig(rule, bytes): { ok: boolean; values?: Record<string, unknown>; error?: string }
```
Signing happens in the CLI with viem `account.signMessage({ message: { raw: digest } })`. `core` only verifies.
