import { describe, expect, it } from "vitest";
import type { SnapshotSummary, Verdict } from "@unforged/core";
import {
  blockedFileLabel,
  buildersCount,
  configValueText,
  dappOf,
  parseMock,
  parseTabId,
  reasonText,
  relativeTime,
  shortAddress,
  shortCommit,
  shortHash,
  statusLabel,
  verifiedCopyAvailable,
} from "./format.js";

const HASH = "3793d238759876e77f287bcec730ea1ba1ef12ceb8a4c8fb1d64410ee5bdeaa7";

describe("reasonText", () => {
  it("puts every block reason in plain words", () => {
    expect(reasonText("hash-mismatch")).toBe("changed");
    expect(reasonText("unknown-file")).toBe("not part of the release");
    expect(reasonText("third-party")).toBe("external script not allowed");
    expect(reasonText("config-invalid")).toBe("configuration not allowed");
    expect(reasonText("release-mixed")).toBe("from a different release");
  });
});

describe("statusLabel", () => {
  it("names each verdict level", () => {
    expect(statusLabel("reproduced")).toBe("Reproduced");
    expect(statusLabel("vendor")).toBe("Vendor-attested");
    expect(statusLabel("mismatch")).toBe("Doesn't match its public source");
    expect(statusLabel("unsupported")).toBe("Not a supported dapp");
  });
});

describe("short forms", () => {
  it("shortens hashes, keeping both ends", () => {
    expect(shortHash(HASH)).toBe("3793d238…eaa7");
  });

  it("shortens addresses to 0x1234…abcd", () => {
    expect(shortAddress("0x1234567890123456789012345678901234abcd")).toBe("0x1234…abcd");
  });

  it("keeps the first 7 characters of a commit", () => {
    expect(shortCommit("e256fd6db9f713433b5b95bcf2d2fd833131a547")).toBe("e256fd6");
  });

  it("leaves values that are already short alone", () => {
    expect(shortHash("abc")).toBe("abc");
    expect(shortAddress("0x12")).toBe("0x12");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;

  it("formats minutes, hours and days", () => {
    expect(relativeTime(ago(20_000), now)).toBe("just now");
    expect(relativeTime(ago(MIN), now)).toBe("1 min ago");
    expect(relativeTime(ago(3 * MIN), now)).toBe("3 min ago");
    expect(relativeTime(ago(60 * MIN), now)).toBe("1 hr ago");
    expect(relativeTime(ago(5 * 60 * MIN), now)).toBe("5 hr ago");
    expect(relativeTime(ago(24 * 60 * MIN), now)).toBe("1 day ago");
    expect(relativeTime(ago(3 * 24 * 60 * MIN), now)).toBe("3 days ago");
  });

  it("says never for a snapshot that has not synced", () => {
    expect(relativeTime(null, now)).toBe("never");
  });

  it("does not invent a time from a bad or future timestamp", () => {
    expect(relativeTime("not a date", now)).toBe("unknown");
    expect(relativeTime(ago(-5 * MIN), now)).toBe("just now");
  });
});

describe("blockedFileLabel", () => {
  it("shows only the path for a file of the dapp", () => {
    const url = "http://localhost:8080/_next/static/chunks/main.js?v=2";
    expect(blockedFileLabel({ url, reason: "hash-mismatch", actual: HASH })).toBe("/_next/static/chunks/main.js?v=2");
  });

  it("keeps the host for a third-party script, because the host is the point", () => {
    const url = "http://evil.example:9090/evil.js";
    expect(blockedFileLabel({ url, reason: "third-party", actual: HASH })).toBe("evil.example:9090/evil.js");
  });

  it.each([
    ["http://localhost:8080/", "/ (start page)"],
    ["http://localhost:8080/index.html", "/index.html (start page)"],
    ["http://localhost:8080/?ref=x", "/?ref=x (start page)"],
  ])("marks the start page %s", (url, label) => {
    expect(blockedFileLabel({ url, reason: "hash-mismatch", actual: HASH })).toBe(label);
  });

  it("keeps other paths as they are, including nested index pages", () => {
    const url = "http://localhost:8080/wrap/index.html";
    expect(blockedFileLabel({ url, reason: "unknown-file", actual: HASH })).toBe("/wrap/index.html");
  });

  it("does not call a third-party root a start page", () => {
    const url = "http://evil.example/";
    expect(blockedFileLabel({ url, reason: "third-party", actual: HASH })).toBe("evil.example/");
  });

  it("falls back to the raw text when the url cannot be parsed", () => {
    expect(blockedFileLabel({ url: "not a url", reason: "unknown-file", actual: HASH })).toBe("not a url");
  });
});

describe("configValueText", () => {
  it("reduces URLs to their host", () => {
    expect(configValueText("https://hoodi.drpc.org/v1/key")).toBe("hoodi.drpc.org");
    expect(configValueText(["https://a.example.org/x", "http://localhost:8080"])).toBe("a.example.org, localhost:8080");
  });

  it("shows other values as they are", () => {
    expect(configValueText("production")).toBe("production");
    expect(configValueText(true)).toBe("true");
    expect(configValueText(1)).toBe("1");
    expect(configValueText({ a: 1 })).toBe('{"a":1}');
    expect(configValueText(null)).toBe("null");
    expect(configValueText([])).toBe("none");
  });
});

describe("buildersCount", () => {
  it("shows k of n, or marks n unknown", () => {
    expect(buildersCount(["0x1", "0x2"], 3)).toBe("2 of 3");
    expect(buildersCount(["0x1", "0x2"], undefined)).toBe("2 of ?");
  });
});

describe("dappOf", () => {
  it("reads the tab's dapp, then the verdict's, and treats an empty name as none", () => {
    const unsupported: Verdict = { level: "unsupported" };
    const mismatch: Verdict = { level: "mismatch", dapp: "lido", blocked: [] };
    const base = { checked: 0, blocked: [] };
    expect(dappOf({ ...base, dapp: "a", verdict: unsupported })).toBe("a");
    expect(dappOf({ ...base, verdict: mismatch })).toBe("lido");
    expect(dappOf({ ...base, dapp: "", verdict: { ...mismatch, dapp: "" } })).toBeUndefined();
    expect(dappOf({ ...base, verdict: unsupported })).toBeUndefined();
  });
});

describe("page parameters", () => {
  it("accepts only a whole, non-negative tab id", () => {
    expect(parseTabId("?tab=12")).toBe(12);
    expect(parseTabId("?tab=0")).toBe(0);
    expect(parseTabId("")).toBeUndefined();
    expect(parseTabId("?tab=")).toBeUndefined();
    expect(parseTabId("?tab=-1")).toBeUndefined();
    expect(parseTabId("?tab=1.5")).toBeUndefined();
    expect(parseTabId("?tab=abc")).toBeUndefined();
  });

  it("accepts only the four mock levels", () => {
    expect(parseMock("?mock=reproduced")).toBe("reproduced");
    expect(parseMock("?mock=vendor")).toBe("vendor");
    expect(parseMock("?mock=mismatch")).toBe("mismatch");
    expect(parseMock("?mock=unsupported")).toBe("unsupported");
    expect(parseMock("?mock=other")).toBeUndefined();
    expect(parseMock("?tab=3")).toBeUndefined();
  });
});

describe("verifiedCopyAvailable", () => {
  const summary = (swarmRefs: string[], gateway = "https://gateway.example/bzz/"): SnapshotSummary => ({
    syncedAt: null,
    dapps: [
      {
        dapp: "lido",
        policyVersion: 1,
        buildersTotal: 3,
        threshold: 2,
        gateway,
        releases: [{ release: "1", commit: "abc", builders: [], swarmRefs }],
      },
    ],
  });

  it("needs a release of that dapp mirrored on Swarm", () => {
    expect(verifiedCopyAvailable(summary(["ref"]), "lido")).toBe(true);
    expect(verifiedCopyAvailable(summary([]), "lido")).toBe(false);
    expect(verifiedCopyAvailable(summary(["ref"]), "other")).toBe(false);
    expect(verifiedCopyAvailable(summary(["ref"]), undefined)).toBe(false);
    expect(verifiedCopyAvailable(undefined, "lido")).toBe(false);
  });

  it("needs a recovery gateway", () => {
    expect(verifiedCopyAvailable(summary(["ref"], "TODO"), "lido")).toBe(false);
    expect(verifiedCopyAvailable(summary(["ref"], ""), "lido")).toBe(false);
  });
});
