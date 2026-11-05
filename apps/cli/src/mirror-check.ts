import { type Manifest, sha256Hex } from "@unforged/core";
import { gatewayUrl } from "@unforged/registry";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";

const CONCURRENCY = 8;
const ATTEMPTS = 2; // one retry, on network errors only
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LISTED_PROBLEMS = 20;
const MAX_REF_BYTES = 128; // Arkiv's limit for a string attribute
export const NO_MIRROR_REF = "none"; // what swarm_ref holds with no mirror, so it can't name one

export interface MirrorCheckOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface MirrorProblem {
  path: string;
  problem: string;
}

export interface MirrorReport {
  matched: number;
  total: number;
  problems: MirrorProblem[];
}

export const mirrorPassed = (report: MirrorReport) => report.problems.length === 0;

/**
 * Compares a mirror with a manifest. The host is untrusted, so every file's bytes are hashed.
 * Config files only need to exist: their bytes are pinned in the policy, not the manifest.
 */
export async function checkMirror(manifest: Manifest, gateway: string, ref: string, options: MirrorCheckOptions = {}): Promise<MirrorReport> {
  assertMirrorTarget(gateway, ref);
  const { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const checks = [
    ...Object.entries(manifest.files).map(([path, expected]) => ({ path, expected })),
    ...Object.keys(manifest.config).map((path) => ({ path, expected: null })),
  ];
  if (checks.length === 0) return { matched: 0, total: 0, problems: [{ path: "(manifest)", problem: "lists no files" }] };

  const outcomes = await mapLimited(checks, CONCURRENCY, async ({ path, expected }) => {
    const problem = await checkFile(fetch, timeoutMs, gateway, ref, path, expected);
    return problem === null ? null : { path, problem };
  });
  const problems = outcomes.filter((outcome) => outcome !== null);
  return { matched: checks.length - problems.length, total: checks.length, problems };
}

export function formatMirrorReport({ matched, total, problems }: MirrorReport): string {
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).map(({ path, problem }) => `  ${path}: ${problem}`);
  const hidden = problems.length - listed.length;
  return [`${matched}/${total} match`, ...listed, ...(hidden > 0 ? [`  ...and ${hidden} more`] : [])].join("\n");
}

function assertMirrorTarget(gateway: string, ref: string): void {
  try {
    gatewayUrl(gateway, ref, "/");
  } catch (error) {
    throw new CliError(EXIT_BAD_INPUT, (error as Error).message);
  }
  if (ref === NO_MIRROR_REF) throw new CliError(EXIT_BAD_INPUT, `mirror ref can't be "${NO_MIRROR_REF}": it reads back as no mirror`);
  if (ref.length > MAX_REF_BYTES) throw new CliError(EXIT_BAD_INPUT, `mirror ref is over ${MAX_REF_BYTES} bytes`);
}

/** One file's problem, or null if it is fine. `expected` null means it only has to exist. */
async function checkFile(
  fetch: typeof globalThis.fetch,
  timeoutMs: number,
  gateway: string,
  ref: string,
  path: string,
  expected: string | null,
): Promise<string | null> {
  let url: string;
  try {
    url = gatewayUrl(gateway, ref, path);
  } catch (error) {
    return (error as Error).message;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      // The signal covers the whole exchange, so a body that stalls times out as well.
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200 || expected === null) {
        await response.body?.cancel();
        return response.status === 200 ? null : `HTTP ${response.status}`;
      }
      const actual = await sha256Hex(new Uint8Array(await response.arrayBuffer()));
      return actual === expected ? null : `hash mismatch: expected ${expected}, got ${actual}`;
    } catch (error) {
      if (attempt === ATTEMPTS) return `fetch failed (${networkErrorName(error)})`;
    }
  }
}

function networkErrorName(error: unknown): string {
  const { name, cause } = (error ?? {}) as { name?: string; cause?: { code?: string } };
  return cause?.code ?? name ?? "unknown";
}

/** Like Promise.all over a map, with at most `limit` calls running. Results keep the input's order. */
async function mapLimited<T, R>(items: T[], limit: number, call: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await call(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
