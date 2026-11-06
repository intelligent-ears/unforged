import { HttpRequestError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAttestations, fetchPolicies, findAttestation, publishAttestation, publishPolicy, withBackoff, type WriteClient } from "./arkiv.js";

const CURATOR = "0x2222222222222222222222222222222222222222" as const;
const PUBLIC_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network";

const rateLimited = (retryAfter?: string) =>
  new HttpRequestError({
    status: 429,
    url: PUBLIC_RPC,
    headers: new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
  });

describe("schemas", () => {
  /** The schema each publish function hands to createEntity. */
  async function schemaUsedBy(publish: (client: WriteClient) => Promise<unknown>) {
    const createEntity = vi.fn(async (..._: unknown[]) => ({ entityKey: "0xk", txHash: "0xt", expiresAt: 1n }));
    await publish({ createEntity } as unknown as WriteClient);
    return createEntity.mock.calls[0]?.[0] as { columns: Record<string, unknown> };
  }

  const anything = {} as never;
  const attrs = { dapp: "d", release: "r", commit: "c", manifest_root: "m", recipe_digest: "g", swarm_ref: "none" };
  const policy = { policy: { dapp: "d" }, signature: "0x" } as never;

  it("has one schema per entity kind, with the formats.md attributes", async () => {
    const attestation = await schemaUsedBy((c) => publishAttestation(c, anything, attrs));
    const policySchema = await schemaUsedBy((c) => publishPolicy(c, policy, 1));

    expect(attestation).not.toBe(policySchema);
    expect(Object.keys(attestation.columns).sort()).toEqual(
      ["commit", "content_type", "dapp", "entity_type", "manifest_root", "payload", "project", "recipe_digest", "release", "swarm_ref"],
    );
    expect(Object.keys(policySchema.columns).sort()).toEqual(["content_type", "dapp", "entity_type", "payload", "project", "version"]);
    expect(policySchema.columns.version).toMatchObject({ type: "u64", isIndexed: true });
  });
});

describe("withBackoff", () => {
  const delaysOf = (sleep: ReturnType<typeof vi.fn>) => sleep.mock.calls.map(([ms]) => ms);

  it("doubles the delay on each 429, then gives up with the error", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn(async () => {
      throw rateLimited();
    });
    await expect(withBackoff(call, sleep)).rejects.toBeInstanceOf(HttpRequestError);
    expect(delaysOf(sleep)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(call).toHaveBeenCalledTimes(6);
  });

  it("returns as soon as a retry succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValueOnce(rateLimited()).mockResolvedValue("ok");
    await expect(withBackoff(call, sleep)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After in seconds", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValueOnce(rateLimited("3")).mockResolvedValue("ok");
    await withBackoff(call, sleep);
    expect(delaysOf(sleep)).toEqual([3000]);
  });

  it("caps a huge Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValueOnce(rateLimited("86400")).mockResolvedValue("ok");
    await withBackoff(call, sleep);
    expect(delaysOf(sleep)).toEqual([60_000]);
  });

  it("falls back to doubling when Retry-After isn't a number of seconds", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValueOnce(rateLimited("Wed, 21 Oct 2026 07:28:00 GMT")).mockResolvedValue("ok");
    await withBackoff(call, sleep);
    expect(delaysOf(sleep)).toEqual([500]);
  });

  it("finds a 429 wrapped in a cause", async () => {
    const sleep = vi.fn(async () => {});
    const wrapped = new Error("query failed", { cause: rateLimited() });
    const call = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValue("ok");
    await expect(withBackoff(call, sleep)).resolves.toBe("ok");
  });

  it.each([
    ["another HTTP status", new HttpRequestError({ status: 500, url: PUBLIC_RPC })],
    ["a non-HTTP error", new Error("query rejected")],
  ])("does not retry %s", async (_, error) => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValue(error);
    await expect(withBackoff(call, sleep)).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("read functions, through the real SDK and viem over a stubbed fetch", () => {
  const jsonRpc = (body: string, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(body) as { id: number }).id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const emptyPage = { data: [], blockNumber: "0x1" };

  /** Answers each request with the next status, recording the URLs it was sent to. */
  function stubFetch(statuses: number[]) {
    const urls: string[] = [];
    const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      const status = statuses.shift() ?? 200;
      return status === 200 ? jsonRpc(String(init?.body), emptyPage) : new Response("{}", { status });
    });
    vi.stubGlobal("fetch", fetchStub);
    return { urls, fetchStub };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs a read to completion, letting any backoff timers fire. */
  async function settled<T>(read: Promise<T>): Promise<T> {
    const guarded = read.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const outcome = (await guarded) as { value: T } | { error: unknown };
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  it.each([
    ["no key", {}],
    ["an empty key", { accessKey: "" }],
  ])("uses the public RPC with %s", async (_, source) => {
    const { urls } = stubFetch([200]);
    await expect(settled(fetchPolicies(source, CURATOR))).resolves.toEqual([]);
    expect(urls).toEqual([`${PUBLIC_RPC}/`]); // viem sends the bare host with its root path, and no key
  });

  it("uses the keyed RPC when given a key, for every read function", async () => {
    const { urls } = stubFetch([200, 200, 200]);
    const source = { accessKey: "test-access-key" };
    await settled(fetchPolicies(source, CURATOR));
    await settled(fetchAttestations(source, CURATOR, "demo"));
    await settled(findAttestation(source, CURATOR, "d".repeat(64)));
    expect(urls).toEqual(Array(3).fill(`${PUBLIC_RPC}/test-access-key`));
  });

  it("retries a 429 and then returns the result", async () => {
    const { fetchStub } = stubFetch([429, 429, 200]);
    await expect(settled(fetchPolicies({}, CURATOR))).resolves.toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("throws when the 429s don't stop, rather than returning an empty list", async () => {
    const { fetchStub } = stubFetch(Array(20).fill(429));
    await expect(settled(fetchPolicies({}, CURATOR))).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });

  it("does not retry another HTTP failure, or double up with viem's own retries", async () => {
    const { fetchStub } = stubFetch([500, 200]);
    await expect(settled(fetchPolicies({}, CURATOR))).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
