import { describe, expect, it } from "vitest";
import snapshotJson from "../fixtures/snapshot.json";
import type { Snapshot } from "./decide.js";
import { snapshotSummary } from "./summary.js";

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
