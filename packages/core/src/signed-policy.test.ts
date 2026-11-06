import { describe, expect, it } from "vitest";
import { canonicalJSON, policyDigest, sha256Canonical, signPolicy, verifyPolicy, type SignedPolicy } from "./index.js";
import { newBuilder, policy } from "./fixtures.test-helpers.js";

const newCurator = newBuilder;

describe("policyDigest", () => {
  it("is sha256 of the canonical { policy, version }, as 0x hex", async () => {
    const p = policy([newBuilder()]);
    expect(await policyDigest(p, 3)).toBe(`0x${await sha256Canonical({ policy: p, version: 3 })}`);
    expect(await policyDigest(p, 3)).not.toBe(await policyDigest(p, 4));
  });
});

describe("verifyPolicy", () => {
  it("accepts a policy signed by the expected curator, in any address case", async () => {
    const curator = newCurator();
    const signed = await signPolicy(policy([newBuilder()]), 1, curator);
    expect(await verifyPolicy(signed, curator.address)).toBe(true);
    expect(await verifyPolicy(signed, curator.address.toLowerCase() as `0x${string}`)).toBe(true);
  });

  it("survives a JSON round trip, since the digest is over canonical JSON", async () => {
    const curator = newCurator();
    const signed = await signPolicy(policy([newBuilder()]), 1, curator);
    expect(await verifyPolicy(JSON.parse(canonicalJSON(signed)) as SignedPolicy, curator.address)).toBe(true);
  });

  it("rejects a signature by another key", async () => {
    const signed = await signPolicy(policy([newBuilder()]), 1, newCurator());
    expect(await verifyPolicy(signed, newCurator().address)).toBe(false);
  });

  it("rejects a policy altered after signing", async () => {
    const curator = newCurator();
    const signed = await signPolicy(policy([newBuilder()]), 1, curator);
    const altered = { ...signed, policy: { ...signed.policy, threshold: 1 } };
    expect(await verifyPolicy(altered, curator.address)).toBe(false);
  });

  it("carries the version it signed, and rejects a changed version", async () => {
    const curator = newCurator();
    const signed = await signPolicy(policy([newBuilder()]), 2, curator);
    expect(signed.version).toBe(2);
    expect(await verifyPolicy({ ...signed, version: 9 }, curator.address)).toBe(false);
  });

  it.each([
    ["an unsigned policy", () => policy([newBuilder()])],
    ["a malformed signature", () => ({ policy: policy([newBuilder()]), version: 1, signature: "0x1234" })],
    ["a missing version", () => ({ policy: policy([newBuilder()]), signature: `0x${"11".repeat(65)}` })],
    ["a missing policy", () => ({ signature: `0x${"11".repeat(65)}` })],
    ["a non-canonical value", () => ({ policy: { threshold: 1.5 }, signature: `0x${"11".repeat(65)}` })],
    ["null", () => null],
  ])("returns false, not throws, for %s", async (_, make) => {
    expect(await verifyPolicy(make() as unknown as SignedPolicy, newCurator().address)).toBe(false);
  });
});
