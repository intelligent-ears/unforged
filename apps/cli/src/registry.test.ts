import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { accessKeyFromEnv } from "./keys.js";
import { explorerAddressUrl, explorerTxUrl, registryCall, registryWrite } from "./registry.js";

const KEY = "s3cret/key";
const env = { ARKIV_ACCESS_KEY: KEY };
const fail = (error: unknown) => async () => {
  throw error;
};
const caught = (promise: Promise<unknown>) => promise.catch((e: unknown) => e) as Promise<CliError>;

describe("explorer links", () => {
  it("point at Rabdi", () => {
    expect(explorerTxUrl("0xabc")).toBe("https://rabdi.explorer.arkiv.network/tx/0xabc");
    expect(explorerAddressUrl("0xdef")).toBe("https://rabdi.explorer.arkiv.network/address/0xdef");
  });
});

describe("accessKeyFromEnv", () => {
  it("reads ARKIV_ACCESS_KEY", () => {
    expect(accessKeyFromEnv(env)).toBe(KEY);
  });

  it("fails without it, rather than falling back to keyless writes", () => {
    expect(() => accessKeyFromEnv({})).toThrow(/ARKIV_ACCESS_KEY is not set/);
    expect(() => accessKeyFromEnv({ ARKIV_ACCESS_KEY: "  " })).toThrow(/ARKIV_ACCESS_KEY is not set/);
  });
});

describe("registryCall", () => {
  it("uses the registry exit code", async () => {
    await expect(registryCall(fail(new Error("rpc down")), env)).rejects.toMatchObject({ exitCode: 4, message: "registry error: rpc down" });
  });

  it("removes a keyed RPC URL from a viem-style error", async () => {
    const url = `https://rpc.rabdi.db-chain.testnet.arkiv.network/${encodeURIComponent(KEY)}`;
    const error = await caught(registryCall(fail(new Error(`HTTP request failed.\n\nStatus: 429\nURL: ${url}\nRequest body: {}`)), env));
    expect(error.message).not.toContain("s3cret");
    expect(error.message).toContain("HTTP request failed");
  });

  it("removes the key wherever else it appears, raw or URL-encoded", async () => {
    for (const leaked of [KEY, encodeURIComponent(KEY)]) {
      const error = await caught(registryCall(fail(new Error(`bad key ${leaked} rejected`)), env));
      expect(error.message).not.toContain("s3cret");
    }
  });

  it("removes a URL even from shortMessage, and never reads the cause", async () => {
    const leaky = Object.assign(new Error("long"), {
      shortMessage: "failed at https://rpc.example/abc",
      cause: new Error(KEY),
    });
    const error = await caught(registryCall(fail(leaky), {}));
    expect(error.message).toBe("registry error: failed at [url]");
  });
});

describe("registryWrite", () => {
  it("warns that a send may have happened, and keeps a known tx hash", async () => {
    const hash = `0x${"a".repeat(64)}`;
    const error = await caught(registryWrite(fail(Object.assign(new Error("timed out"), { txHash: hash })), env));
    expect(error.exitCode).toBe(4);
    expect(error.message).toContain(hash);
    expect(error.message).toMatch(/before retrying/);
  });
});
