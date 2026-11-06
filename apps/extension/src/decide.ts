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
import { pathIn, type Site } from "./site.js";

/** extension.md sync step 5. */
export interface Snapshot {
  syncedAt: string | null;
  dapps: Record<string, DappEntry>;
}

export interface DappEntry {
  policy: Policy;
  releases: AcceptedRelease[]; // newest first
  policyVersion?: number; // absent only in the hand-made fixture
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
  site?: Site; // where the tab's document came from; defaults to the policy for tabOrigin
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
  return resolvePath(decodeURIComponent(new URL(url).pathname), files);
}

/** The manifest key for a served path: "/" and "/dir/" mean index.html, extensionless paths try .html. */
export function resolvePath(path: string, files: Record<string, string>): string {
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
    const site = req.site ?? originSite(snapshot, req.tabOrigin);
    const entry = site && snapshot.dapps[site.dapp];
    if (!site || !entry) throw new Error(`no policy for ${req.tabOrigin}`);
    if (req.type === "main_frame") resetTab(tab, entry.policy.dapp);
    const blocked = check(entry.policy, entry.releases, site, tab, req, sha256);
    return record(tab, entry.policy.dapp, req.url, blocked);
  } catch (error) {
    console.error("unforged: decision failed, blocking", { url: req.url, error });
    return record(tab, tab.state.dapp ?? "", req.url, { url: req.url, reason: "unknown-file", actual: sha256 });
  }
}

function originSite(snapshot: Snapshot, origin: string): Site | undefined {
  const entry = policyFor(snapshot, origin);
  return entry && { dapp: entry.policy.dapp, base: `${origin}/` };
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
  site: Site,
  tab: TabRecord,
  req: FileRequest,
  sha256: string,
): Blocked | undefined {
  const path = pathIn(site, req.url);
  // Outside the site: another origin, or on a mirror host, anything outside the release's folder.
  if (path === undefined) return checkThirdParty(policy, req.url, sha256);
  // A mirror folder holds one release, so its document can only lock to that one.
  if (req.type === "main_frame") return lockRelease(site.mirror ? [site.mirror] : releases, tab, req.url, path, sha256);
  if (!tab.lock) return { url: req.url, reason: "release-mixed", actual: sha256 }; // no verified document
  return checkInRelease(policy, tab, releases, req, path, sha256);
}

function checkThirdParty(policy: Policy, url: string, sha256: string): Blocked | undefined {
  const { origin, pathname } = new URL(url);
  const expected = policy.thirdParty[origin]?.[pathname];
  if (expected === sha256) return undefined;
  return { url, reason: "third-party", expected, actual: sha256 };
}

/** The first document picks the release containing its exact hash. */
function lockRelease(
  releases: AcceptedRelease[],
  tab: TabRecord,
  url: string,
  path: string,
  sha256: string,
): Blocked | undefined {
  const match = releases.find((r) => r.manifest.files[resolvePath(path, r.manifest.files)] === sha256);
  if (match) {
    tab.lock = match;
    tab.state.release = match.release;
    return undefined;
  }
  const newest = releases[0];
  if (!newest) return { url, reason: "unknown-file", actual: sha256 };
  const served = resolvePath(path, newest.manifest.files);
  const result = checkFile(newest, served, sha256);
  const expected = newest.manifest.files[served];
  return { url, reason: result === "unknown-file" ? "unknown-file" : "hash-mismatch", expected, actual: sha256 };
}

function checkInRelease(
  policy: Policy,
  tab: TabRecord,
  releases: AcceptedRelease[],
  req: FileRequest,
  requestPath: string,
  sha256: string,
): Blocked | undefined {
  const lock = tab.lock!;
  const path = resolvePath(requestPath, lock.manifest.files);
  const rule = lock.manifest.config[path];
  if (rule) return checkConfigFile(policy, tab, path, rule, req, sha256);
  const result = checkFile(lock, path, sha256);
  if (result === "ok") return undefined;
  const expected = lock.manifest.files[path];
  const inOther = releases.some((r) => r !== lock && checkFile(r, resolvePath(requestPath, r.manifest.files), sha256) === "ok");
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
