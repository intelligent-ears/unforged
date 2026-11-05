// Pure enforcement decision for one buffered response. No browser APIs: background.ts feeds it
// the body and applies the result. Implements extension.md "Background: enforcement".
import {
  checkConfig,
  checkFile,
  sha256Hex,
  type AcceptedRelease,
  type Blocked,
  type ConfigRule,
  type Policy,
  type TabState,
} from "@unforged/core";

/** extension.md sync step 5. */
export interface Snapshot {
  syncedAt: string | null;
  dapps: Record<string, { policy: Policy; releases: AcceptedRelease[]; policyVersion?: number }>;
}

/** Per-tab enforcement state: the UI-facing TabState plus the release the tab is locked to. */
export interface TabRecord {
  state: TabState;
  lock?: AcceptedRelease;
}

export interface FileRequest {
  url: string;
  type: string; // webRequest resource type
  tabOrigin: string; // top-level origin of the tab
  body: Uint8Array;
}

export interface Decision {
  allow: boolean;
  blocked?: Blocked;
}

export function newTab(): TabRecord {
  return { state: { verdict: { level: "unsupported" }, checked: 0, blocked: [] } };
}

const HAS_EXTENSION = /\.[^/]*$/;

/** The manifest key a URL is served from, using the demo server's static-export resolution. */
export function servedPath(url: string, files: Record<string, string>): string {
  const path = decodeURIComponent(new URL(url).pathname);
  if (path.endsWith("/")) return path + "index.html";
  if (HAS_EXTENSION.test(path)) return path;
  for (const candidate of [`${path}/index.html`, `${path}.html`]) {
    if (Object.hasOwn(files, candidate)) return candidate;
  }
  return path;
}

export function policyFor(snapshot: Snapshot, origin: string) {
  return Object.values(snapshot.dapps).find((d) => d.policy.origins.includes(origin));
}

/** Decides one response and records the result on the tab. Any error blocks (fail closed). */
export async function decide(snapshot: Snapshot, tab: TabRecord, req: FileRequest): Promise<Decision> {
  let sha256 = "";
  try {
    sha256 = await sha256Hex(req.body);
    const entry = policyFor(snapshot, req.tabOrigin);
    if (!entry) throw new Error(`no policy for ${req.tabOrigin}`);
    if (req.type === "main_frame") resetTab(tab, entry.policy.dapp);
    const blocked = check(entry.policy, entry.releases, tab, req, sha256);
    return record(tab, entry.policy.dapp, req.url, blocked);
  } catch (error) {
    console.error("unforged: decision failed, blocking", { url: req.url, error });
    return record(tab, tab.state.dapp ?? "", req.url, { url: req.url, reason: "unknown-file", actual: sha256 });
  }
}

function resetTab(tab: TabRecord, dapp: string): void {
  tab.lock = undefined;
  tab.state = { dapp, verdict: { level: "unsupported" }, checked: 0, blocked: [] };
}

/** formats.md §5: accepted only if the policy pins this exact hash AND the rule passes. */
function checkConfigFile(
  policy: Policy,
  tab: TabRecord,
  path: string,
  rule: ConfigRule,
  req: FileRequest,
  sha256: string,
): Blocked | undefined {
  const expected = policy.configPins?.[path];
  if (expected !== sha256) return { url: req.url, reason: "config-invalid", expected, actual: sha256 };
  const result = checkConfig(rule, req.body);
  if (!result.ok) return { url: req.url, reason: "config-invalid", expected, actual: sha256 };
  tab.state.configValues = { ...tab.state.configValues, ...result.values };
  return undefined;
}

/** Returns why the file is blocked, or undefined if it is allowed. */
function check(
  policy: Policy,
  releases: AcceptedRelease[],
  tab: TabRecord,
  req: FileRequest,
  sha256: string,
): Blocked | undefined {
  const url = new URL(req.url);
  if (url.origin !== req.tabOrigin) return checkThirdParty(policy, req.url, sha256);
  if (req.type === "main_frame") return lockRelease(releases, tab, req.url, sha256);
  if (!tab.lock) return { url: req.url, reason: "release-mixed", actual: sha256 }; // no verified document
  return checkInRelease(policy, tab, releases, req, sha256);
}

function checkThirdParty(policy: Policy, url: string, sha256: string): Blocked | undefined {
  const { origin, pathname } = new URL(url);
  const expected = policy.thirdParty[origin]?.[pathname];
  if (expected === sha256) return undefined;
  return { url, reason: "third-party", expected, actual: sha256 };
}

/** The first document picks the release containing its exact hash. */
function lockRelease(releases: AcceptedRelease[], tab: TabRecord, url: string, sha256: string): Blocked | undefined {
  const match = releases.find((r) => r.manifest.files[servedPath(url, r.manifest.files)] === sha256);
  if (match) {
    tab.lock = match;
    tab.state.release = match.release;
    return undefined;
  }
  const newest = releases[0];
  if (!newest) return { url, reason: "unknown-file", actual: sha256 };
  const result = checkFile(newest, servedPath(url, newest.manifest.files), sha256);
  const expected = newest.manifest.files[servedPath(url, newest.manifest.files)];
  return { url, reason: result === "unknown-file" ? "unknown-file" : "hash-mismatch", expected, actual: sha256 };
}

function checkInRelease(
  policy: Policy,
  tab: TabRecord,
  releases: AcceptedRelease[],
  req: FileRequest,
  sha256: string,
): Blocked | undefined {
  const lock = tab.lock!;
  const path = servedPath(req.url, lock.manifest.files);
  const rule = lock.manifest.config[path];
  if (rule) return checkConfigFile(policy, tab, path, rule, req, sha256);
  const result = checkFile(lock, path, sha256);
  if (result === "ok") return undefined;
  const expected = lock.manifest.files[path];
  const inOther = releases.some((r) => r !== lock && checkFile(r, servedPath(req.url, r.manifest.files), sha256) === "ok");
  return { url: req.url, reason: inOther ? "release-mixed" : result, expected, actual: sha256 };
}

/** Applies the outcome to the tab and recomputes its verdict. */
function record(tab: TabRecord, dapp: string, url: string, blocked: Blocked | undefined): Decision {
  const state = tab.state;
  state.checked += 1;
  if (blocked) state.blocked.push(blocked);
  if (state.blocked.length > 0) {
    state.verdict = { level: "mismatch", dapp, blocked: [...state.blocked] };
  } else if (tab.lock) {
    state.verdict = { level: "reproduced", dapp, release: tab.lock.release, builders: tab.lock.builders };
  }
  return blocked ? { allow: false, blocked } : { allow: true };
}
