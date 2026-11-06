import { describe, expect, it } from "vitest";
import snapshotJson from "../fixtures/snapshot.json";
import type { Snapshot } from "./decide.js";
import { snapshotSummary, syncSummary } from "./summary.js";

describe("snapshotSummary", () => {
  it("summarises the fixture snapshot for the UI", () => {
    const summary = snapshotSummary(snapshotJson as unknown as Snapshot);
    expect(summary.syncedAt).toBe(snapshotJson.syncedAt);
    expect(summary.dapps).toEqual([
      {
        dapp: "lido-staking-widget",
        policyVersion: 0,
        buildersTotal: 3,
        threshold: 2,
        gateway: "TODO",
        releases: [
          {
            release: "0.161.0",
            commit: "e256fd6db9f713433b5b95bcf2d2fd833131a547",
            builders: snapshotJson.dapps["lido-staking-widget"].releases[0]!.builders,
            swarmRefs: [],
          },
        ],
      },
    ]);
  });

});

describe("syncSummary", () => {
  it("reports the last error and the synced policy version", () => {
    const snap = { ...(snapshotJson as unknown as Snapshot) };
    snap.dapps = { "lido-staking-widget": { ...snap.dapps["lido-staking-widget"]!, policyVersion: 4 } };
    const summary = syncSummary(snap, "HTTP request failed.");
    expect(summary.lastError).toBe("HTTP request failed.");
    expect(summary.dapps[0]!.policyVersion).toBe(4);
    expect(summary.syncedAt).toBe(snapshotJson.syncedAt);
  });

  it("says never synced when there is no snapshot", () => {
    expect(syncSummary(null, null)).toEqual({ syncedAt: null, dapps: [], lastError: null });
  });
});
