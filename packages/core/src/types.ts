// The contract between all packages (docs/formats.md). DRAFT for the 3 Nov walkthrough:
// agree on it, then it is frozen after M1. Change it only with all three of you agreeing.

export type Hex = `0x${string}`;
export type Sha256 = string; // lowercase hex, 64 chars

/** §5 Config file sanity rule. Acceptance also needs policy.configPins (§4). */
export interface ConfigRule {
  kind: "window-env-json";
  allowedKeys: string[];
  urlHostAllowlist?: string[];
}

/** §1 Everything a rebuild depends on besides the source. recipeDigest = sha256(canonicalJSON(recipe)). */
export interface Recipe {
  dapp: string; // [a-z0-9-]+
  release: string;
  repo: string; // https URL
  commit: string; // 40-hex
  node: string; // major ("24") or exact ("22.23.4")
  packageManager: string; // as in package.json, e.g. "yarn@4.17.1"
  files: Record<string, string>; // path -> literal content written before install
  env: Record<string, string>; // public build config values
  envFile: string; // e.g. ".env.production.local"
  buildPath: string; // absolute; every builder uses the same one
  install: string;
  build: string;
  output: string; // dir relative to repo root
  configFiles: Record<string, ConfigRule>; // served path -> rule
}

/** §2 manifestRoot = sha256(canonicalJSON(manifest)). */
export interface Manifest {
  version: 1;
  dapp: string;
  release: string;
  commit: string;
  files: Record<string, Sha256>; // "/index.html" -> hash; paths start with "/"
  config: Record<string, ConfigRule>; // config files, not listed in files
}

/** §3 in-toto Statement v1. */
export interface Statement {
  _type: "https://in-toto.io/Statement/v1";
  subject: [{ name: string; digest: { sha256: Sha256 } }]; // name "<dapp>@<release>", digest = manifestRoot
  predicateType: "https://unforged.dev/rebuild/v1";
  predicate: {
    repo: string;
    commit: string;
    recipeDigest: Sha256;
    builder: Hex; // checksummed address
    builtAt: string; // ISO 8601
    toolchain: { node: string; packageManager: string; os: string };
  };
}

export interface SignedAttestation {
  statement: Statement;
  signature: Hex; // EIP-191 personal_sign over the raw 32-byte statementDigest
}

/** §4 Policy entity payload (created by the curator). */
export interface Policy {
  dapp: string;
  origins: string[];
  repo: string;
  builders: Hex[];
  threshold: number; // k
  acceptLatest: number; // m, downgrade protection
  thirdParty: Record<string, Record<string, Sha256>>; // origin -> path -> hash
  recovery: { gateway: string }; // Swarm gateway base, e.g. "https://<gateway>/bzz/"
  configPins?: Record<string, Sha256>; // served config path -> hash; a config file is accepted only if pinned (§5)
}

/** Input to acceptReleases: one decoded Arkiv attestation entity. */
export interface AttestationEntry {
  entityKey?: string;
  creator: Hex;
  attestation: SignedAttestation;
  manifest: Manifest;
  swarmRef: string | null; // "none" -> null
}

/** §6 */
export interface Blocked {
  url: string;
  reason: "unknown-file" | "hash-mismatch" | "third-party" | "config-invalid" | "release-mixed";
  expected?: Sha256;
  actual: Sha256;
}

export type Verdict =
  | { level: "reproduced"; dapp: string; release: string; builders: string[] }
  | { level: "vendor"; dapp: string; release: string } // stretch
  | { level: "mismatch"; dapp: string; blocked: Blocked[] }
  | { level: "unsupported" };

export interface AcceptedRelease {
  dapp: string;
  release: string;
  commit: string;
  manifestRoot: Sha256;
  manifest: Manifest;
  builders: Hex[];
  builtAt: string;
  swarmRefs: string[];
}

export interface TabState {
  dapp?: string;
  release?: string;
  verdict: Verdict;
  checked: number;
  blocked: Blocked[];
  configValues?: Record<string, unknown>;
}

export interface SnapshotSummary {
  syncedAt: string | null;
  dapps: {
    dapp: string;
    policyVersion: number;
    buildersTotal: number;
    threshold: number;
    gateway: string;
    releases: { release: string; commit: string; builders: string[]; swarmRefs: string[] }[];
  }[];
}

export type CheckFileResult = "ok" | "unknown-file" | "hash-mismatch";
export interface CheckConfigResult { ok: boolean; values?: Record<string, unknown>; error?: string }
