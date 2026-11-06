// What the popup and blocked page read about the synced snapshot (formats.md §6 SnapshotSummary).
import type { SnapshotSummary } from "@unforged/core";
import type { Snapshot } from "./decide.js";

/** SnapshotSummary plus why the last sync failed. The extra field is the extension's own. */
export interface SyncSummary extends SnapshotSummary {
  lastError: string | null;
}

export function syncSummary(snapshot: Snapshot | null, lastError: string | null): SyncSummary {
  return snapshot === null ? { syncedAt: null, dapps: [], lastError } : { ...snapshotSummary(snapshot), lastError };
}

export function snapshotSummary(snapshot: Snapshot): SnapshotSummary {
  return {
    syncedAt: snapshot.syncedAt,
    dapps: Object.entries(snapshot.dapps).map(([dapp, { policy, releases, policyVersion }]) => ({
      dapp,
      policyVersion: policyVersion ?? 0,
      buildersTotal: policy.builders.length,
      threshold: policy.threshold,
      gateway: policy.recovery.gateway,
      releases: releases.map((r) => ({
        release: r.release,
        commit: r.commit,
        builders: r.builders,
        swarmRefs: r.swarmRefs,
      })),
    })),
  };
}
