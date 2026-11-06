// Browser side of sync: storage, the 10-minute alarm, Arkiv reads and HTTP cache clearing.
// The logic is in sync.ts. Sync is time-based only: nothing here runs because a site was visited.
import { fetchAttestations, fetchPolicies } from "@unforged/registry";
import { CURATOR_ADDRESS, MANUAL_SYNC_GAP_MS, SYNC_PERIOD_MINUTES } from "./config.js";
import type { Snapshot } from "./decide.js";
import { mirrorBase } from "./site.js";
import { syncSummary, type SyncSummary } from "./summary.js";
import { sync, type CachedEntry, type Registry } from "./sync.js";

// Set by Vite (vite.config.ts). Only an UNFORGED_FIXTURE=1 build contains the demo fixture.
declare const __UNFORGED_FIXTURE__: boolean;

/** storage.local keys. The access key is written by the options page and only read here. */
export const STORAGE = {
  snapshot: "snapshot",
  entries: "attestations", // entity key -> CachedEntry
  lastError: "lastError",
  accessKey: "accessKey",
} as const;

const SYNC_ALARM = "unforged-sync";

let synced: Snapshot | null = null; // last good synced snapshot
let fixture: Snapshot | null = null; // demo fallback, only in a fixture build and only before a sync
let lastError: string | null = null;
let running: Promise<void> | undefined;
let lastManualSync = 0;

/** Resolves once the stored snapshot is in memory. Enforcement waits for it. */
export const ready: Promise<void> = load();

async function load(): Promise<void> {
  try {
    const stored = await browser.storage.local.get([STORAGE.snapshot, STORAGE.lastError]);
    synced = (stored[STORAGE.snapshot] as Snapshot | undefined) ?? null;
    lastError = (stored[STORAGE.lastError] as string | undefined) ?? null;
  } catch (error) {
    console.error("unforged: could not read the stored snapshot", error);
  }
  if (synced === null && __UNFORGED_FIXTURE__) {
    fixture = (await import("../fixtures/snapshot.json")).default as unknown as Snapshot;
  }
}

/** The snapshot enforcement uses, or null if there has never been a sync. */
export function currentSnapshot(): Snapshot | null {
  return synced ?? fixture;
}

export function summary(): SyncSummary {
  return syncSummary(currentSnapshot(), lastError);
}

/** Starts a sync, or joins the one already running. */
export function syncSoon(): Promise<void> {
  running ??= runSync().finally(() => {
    running = undefined;
  });
  return running;
}

/** The popup's "Sync now": at most once per MANUAL_SYNC_GAP_MS. */
export async function syncNow(): Promise<{ ok: true } | { error: string }> {
  const wait = lastManualSync + MANUAL_SYNC_GAP_MS - Date.now();
  if (wait > 0) return { error: `Synced moments ago. Try again in ${Math.ceil(wait / 1000)} s.` };
  lastManualSync = Date.now();
  await syncSoon();
  return { ok: true };
}

async function runSync(): Promise<void> {
  await ready;
  const stored = await browser.storage.local.get([STORAGE.entries, STORAGE.accessKey]);
  const accessKey = typeof stored[STORAGE.accessKey] === "string" ? (stored[STORAGE.accessKey] as string) : "";
  const entries = (stored[STORAGE.entries] as Record<string, CachedEntry> | undefined) ?? {};
  const result = await sync(arkiv(accessKey), CURATOR_ADDRESS, { snapshot: synced, entries, lastError }, new Date(), accessKey);

  lastError = result.lastError;
  if (result.lastError !== null) {
    console.warn("unforged: sync failed, keeping the last snapshot:", result.lastError); // already scrubbed of the key
    await browser.storage.local.set({ [STORAGE.lastError]: result.lastError });
    return;
  }
  synced = result.snapshot;
  fixture = null;
  await browser.storage.local.set({
    [STORAGE.snapshot]: result.snapshot,
    [STORAGE.entries]: result.entries,
    [STORAGE.lastError]: null,
  });
  if (result.changed && result.snapshot) await clearCache(result.snapshot);
}

/** Arkiv Rabdi. No key means the public RPC; the registry retries its 429s. */
function arkiv(accessKey: string): Registry {
  const source = accessKey === "" ? {} : { accessKey };
  return {
    fetchPolicies: (curator) => fetchPolicies(source, curator),
    fetchAttestations: (builder, dapp, skipKeys) => fetchAttestations(source, builder, dapp, skipKeys),
  };
}

/**
 * After a change, drop cached files of every checked origin, so a cached response can't skip
 * verification. If Firefox refuses the origin filter, clear the whole HTTP cache instead.
 */
async function clearCache(snapshot: Snapshot): Promise<void> {
  const origins = checkedOrigins(snapshot);
  if (origins.length === 0) return;
  try {
    await browser.browsingData.remove({ origins } as browser.browsingData.RemovalOptions, { cache: true });
  } catch (error) {
    console.warn("unforged: per-origin cache clearing failed, clearing the whole cache", error);
    await browser.browsingData.removeCache({});
  }
}

/** Policy origins, plus the hosts of mirrored releases (they are checked the same way). */
function checkedOrigins(snapshot: Snapshot): string[] {
  const origins = new Set<string>();
  for (const { policy, releases } of Object.values(snapshot.dapps)) {
    for (const origin of policy.origins) origins.add(origin);
    for (const ref of releases.flatMap((r) => r.swarmRefs)) {
      const base = mirrorBase(policy.recovery.gateway, ref);
      if (base !== undefined) origins.add(new URL(base).origin);
    }
  }
  return [...origins];
}

/** Sync on install, on browser start, and every SYNC_PERIOD_MINUTES. */
export function scheduleSync(): void {
  const start = () => {
    browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
    void syncSoon();
  };
  browser.runtime.onInstalled.addListener(start);
  browser.runtime.onStartup.addListener(start);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void syncSoon();
  });
  // Recreating an existing alarm would restart its period each time this event page wakes up.
  void browser.alarms.get(SYNC_ALARM).then((alarm) => {
    if (!alarm) browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  });
}
