// Pure display helpers for the popup and blocked page. They format what the background reports;
// none of them decide whether anything is safe.
import type { Blocked, SnapshotSummary, TabState, Verdict } from "@unforged/core";

export type Level = Verdict["level"];

const REASONS: Record<Blocked["reason"], string> = {
  "hash-mismatch": "changed",
  "unknown-file": "not part of the release",
  "third-party": "external script not allowed",
  "config-invalid": "configuration not allowed",
  "release-mixed": "from a different release",
};

const STATUS: Record<Level, string> = {
  reproduced: "Reproduced",
  vendor: "Vendor-attested",
  mismatch: "Doesn't match its public source",
  unsupported: "Not a supported dapp",
};

export function reasonText(reason: Blocked["reason"]): string {
  return REASONS[reason];
}

export function statusLabel(level: Level): string {
  return STATUS[level];
}

function shorten(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortHash(hash: string): string {
  return shorten(hash, 8, 4);
}

export function shortAddress(address: string): string {
  return shorten(address, 6, 4);
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return plural(Math.floor(hours / 24), "day");
}

function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}

const START_PAGES = new Set(["/", "/index.html"]);

/**
 * The file's path; a third-party script keeps its host, because the host is what's wrong. The
 * dapp's own "/" and "/index.html" are named as the start page, since a bare "/" reads as nothing.
 */
export function blockedFileLabel({ url, reason }: Blocked): string {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  const path = parsed.pathname + parsed.search;
  if (reason === "third-party") return parsed.host + path;
  return START_PAGES.has(parsed.pathname) ? `${path} (start page)` : path;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    const url = parseUrl(value);
    return url && /^https?:$/.test(url.protocol) ? url.host : value;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A config value for display: URLs reduce to their host, the part a person can check. */
export function configValueText(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.map(scalarText).join(", ") : "none";
  return scalarText(value);
}

export function buildersCount(builders: readonly string[], total: number | undefined): string {
  return `${builders.length} of ${total ?? "?"}`;
}

export function parseTabId(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("tab");
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export function parseMock(search: string): Level | undefined {
  const raw = new URLSearchParams(search).get("mock");
  return raw !== null && Object.hasOwn(STATUS, raw) ? (raw as Level) : undefined;
}

export function dappOf({ dapp, verdict }: TabState): string | undefined {
  return dapp || ("dapp" in verdict ? verdict.dapp : undefined) || undefined;
}

/** Whether openVerifiedCopy has anything to open: a release of this dapp mirrored on Swarm. */
export function verifiedCopyAvailable(summary: SnapshotSummary | undefined, dapp: string | undefined): boolean {
  const entry = summary?.dapps.find((d) => d.dapp === dapp);
  if (!entry?.gateway || entry.gateway === "TODO") return false; // recovery is off for this dapp
  return entry.releases.some((r) => r.swarmRefs.length > 0);
}
