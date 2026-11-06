// Sync: builds the snapshot enforcement uses from the curator's policies and the allowlisted
// builders' attestations (extension.md "Background: sync"). Pure: the registry is passed in, so
// this is tested against a mock. background.ts supplies Arkiv, storage and the timer.
import { acceptReleases, canonicalJSON, sameAddress, type AttestationEntry, type Hex, type Policy } from "@unforged/core";
import type { DappEntry, Snapshot } from "./decide.js";

/** The two reads sync needs, already bound to an Arkiv source. */
export interface Registry {
  fetchPolicies(curator: Hex): Promise<{ version: number; policy: Policy }[]>;
  fetchAttestations(builder: Hex, dapp: string, skipKeys: Set<string>): Promise<CachedEntry[]>;
}

/** A decoded attestation entity, cached by its entity key so it is downloaded once. */
export type CachedEntry = AttestationEntry & { entityKey: string };

/** Everything sync keeps in storage.local between runs. */
export interface SyncState {
  snapshot: Snapshot | null; // the last good snapshot; null before the first successful sync
  entries: Record<string, CachedEntry>; // entity key -> entry
  lastError: string | null; // why the last sync failed, or null if it succeeded
}

export interface SyncResult extends SyncState {
  /** The policies or accepted releases differ from the previous snapshot. */
  changed: boolean;
}

export const emptySyncState = (): SyncState => ({ snapshot: null, entries: {}, lastError: null });

const ERROR_TEXT_LIMIT = 300;

/**
 * One sync. On any fetch failure it returns the previous snapshot and cache unchanged, with the
 * error recorded: a partial read must never replace a complete one. `accessKey` is only used to
 * scrub it from that error.
 */
export async function sync(
  registry: Registry,
  curator: Hex,
  previous: SyncState,
  now: Date,
  accessKey = "",
): Promise<SyncResult> {
  try {
    const { snapshot, entries } = await fetchSnapshot(registry, curator, previous.entries, now);
    const changed = contentOf(previous.snapshot) !== contentOf(snapshot);
    return { snapshot, entries, lastError: null, changed };
  } catch (error) {
    return { ...previous, lastError: errorText(error, accessKey), changed: false };
  }
}

async function fetchSnapshot(
  registry: Registry,
  curator: Hex,
  cached: Record<string, CachedEntry>,
  now: Date,
): Promise<{ snapshot: Snapshot; entries: Record<string, CachedEntry> }> {
  const dapps: Record<string, DappEntry> = {};
  const entries: Record<string, CachedEntry> = {};
  for (const { version, policy } of latestPolicies(await registry.fetchPolicies(curator))) {
    const attestations = await attestationsFor(registry, policy, cached);
    for (const entry of attestations) entries[entry.entityKey] = entry;
    // acceptReleases verifies every signature and root itself.
    dapps[policy.dapp] = { policy, policyVersion: version, releases: await acceptReleases(policy, attestations) };
  }
  return { snapshot: { syncedAt: now.toISOString(), dapps }, entries };
}

/** The highest version of each dapp's policy. Policies that don't decode to the §4 shape are skipped. */
export function latestPolicies(rows: { version: number; policy: unknown }[]): { version: number; policy: Policy }[] {
  const latest = new Map<string, { version: number; policy: Policy }>();
  for (const { version, policy } of rows) {
    if (!Number.isSafeInteger(version) || !isPolicy(policy)) continue;
    const current = latest.get(policy.dapp);
    if (!current || version > current.version) latest.set(policy.dapp, { version, policy });
  }
  return [...latest.values()];
}

/**
 * Cached entries for this dapp plus whatever each allowlisted builder published since. Cached
 * entries of builders no longer allowlisted are dropped, which also keeps the cache bounded.
 */
async function attestationsFor(registry: Registry, policy: Policy, cached: Record<string, CachedEntry>): Promise<CachedEntry[]> {
  const known = Object.values(cached).filter(isEntry);
  const skipKeys = new Set(Object.keys(cached));
  const entries: CachedEntry[] = [];
  for (const builder of uniqueAddresses(policy.builders)) {
    entries.push(...known.filter((e) => sameAddress(e.creator, builder) && e.manifest.dapp === policy.dapp));
    const fresh = await registry.fetchAttestations(builder, policy.dapp, skipKeys);
    entries.push(...fresh.filter(isEntry));
  }
  return entries;
}

function uniqueAddresses(addresses: Hex[]): Hex[] {
  return addresses.filter((a, i) => addresses.findIndex((b) => sameAddress(a, b)) === i);
}

/** What a change is measured on: policies, versions and accepted releases, not the sync time. */
function contentOf(snapshot: Snapshot | null): string {
  return snapshot === null ? "" : canonicalJSON(snapshot.dapps);
}

/** A short, single-paragraph error message with the access key removed (viem errors include the RPC URL). */
export function errorText(error: unknown, accessKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = accessKey === "" ? raw : raw.split(accessKey).join("…");
  const firstParagraph = text.split(/\n\s*\n/, 1)[0]!.trim();
  const details = text.match(/^(Status|Details): .*$/m)?.[0];
  const message = details && !firstParagraph.includes(details) ? `${firstParagraph} ${details}` : firstParagraph;
  return message.slice(0, ERROR_TEXT_LIMIT);
}

// ---- Shape checks: anyone can publish under their own key, so decoded JSON is untrusted. ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown) => isObject(v) && Object.values(v).every((x) => typeof x === "string");

/** formats.md §4 Policy. Enforcement reads these fields without further checks. */
export function isPolicy(v: unknown): v is Policy {
  return (
    isObject(v) &&
    typeof v.dapp === "string" &&
    v.dapp !== "" &&
    isStringArray(v.origins) &&
    typeof v.repo === "string" &&
    isStringArray(v.builders) &&
    typeof v.threshold === "number" &&
    typeof v.acceptLatest === "number" &&
    isObject(v.thirdParty) &&
    Object.values(v.thirdParty).every(isStringRecord) &&
    isObject(v.recovery) &&
    typeof v.recovery.gateway === "string" &&
    (v.configPins === undefined || isStringRecord(v.configPins))
  );
}

function isEntry(v: CachedEntry): boolean {
  const e = v as unknown as Record<string, unknown>;
  return (
    typeof e.entityKey === "string" &&
    typeof e.creator === "string" &&
    isObject(e.attestation) &&
    isObject(e.manifest) &&
    typeof e.manifest.dapp === "string" &&
    isStringRecord(e.manifest.files) &&
    (e.swarmRef === null || typeof e.swarmRef === "string")
  );
}
