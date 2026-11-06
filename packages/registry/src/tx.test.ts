import { rabdi } from "@arkiv-network/sdk/chains";
import { numberToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { publishPolicy, type WriteClient } from "./arkiv.js";
import { estimateGas, gasFor, type TxReader, txParamsFor } from "./tx.js";

const account = privateKeyToAccount(generatePrivateKey());
const chain = rabdi({ accessKey: "test" });
const policy = {
  dapp: "demo",
  origins: ["http://localhost:8080"],
  repo: "https://example.com/repo",
  builders: [account.address],
  threshold: 1,
  acceptLatest: 3,
  thirdParty: {},
  recovery: { gateway: "TODO" },
};

/** A Rabdi node that answers reads and records every method called. */
function fakeRpc(overrides: Record<string, unknown> = {}) {
  const methods: string[] = [];
  const answers: Record<string, unknown> = {
    eth_chainId: numberToHex(7794095),
    eth_blockNumber: "0x10",
    eth_getBlockByNumber: {
      number: "0x10",
      hash: `0x${"1".repeat(64)}`,
      gasLimit: numberToHex(100_000_000),
      baseFeePerGas: "0x1",
      timestamp: "0x1",
      transactions: [],
    },
    eth_getTransactionCount: "0x0",
    eth_gasPrice: "0x1",
    eth_maxPriorityFeePerGas: "0x1",
    eth_estimateGas: numberToHex(300_000),
    ...overrides,
  };
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    methods.push(method);
    if (method in answers) return answers[method];
    throw new Error(`unexpected ${method}`);
  });
  return { rpc: { request }, methods };
}

const writePolicy = (client: WriteClient) => publishPolicy(client, { policy, signature: `0x${"11".repeat(65)}` }, 1);

describe("estimateGas", () => {
  it("returns the node's estimate of the exact operation through the real SDK", async () => {
    const { rpc, methods } = fakeRpc();
    await expect(estimateGas(account, chain, rpc, writePolicy)).resolves.toBe(300_000n);
    expect(methods).toContain("eth_estimateGas");
  });

  it("never signs or sends", async () => {
    const { rpc, methods } = fakeRpc();
    const signTransaction = vi.spyOn(account, "signTransaction");
    await estimateGas(account, chain, rpc, writePolicy);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(methods).not.toContain("eth_sendRawTransaction");
    expect(methods).not.toContain("eth_sendTransaction");
  });

  it("refuses a node on another chain", async () => {
    const { rpc } = fakeRpc({ eth_chainId: numberToHex(1) });
    await expect(estimateGas(account, chain, rpc, writePolicy)).rejects.toThrow(/not Rabdi/);
  });

  it("fails if the estimate fails, without detail from the node", async () => {
    const { rpc } = fakeRpc();
    rpc.request.mockImplementation(async ({ method }) => {
      if (method === "eth_chainId") return numberToHex(7794095);
      throw new Error("https://rpc.rabdi.example/secret-key rejected");
    });
    const error = (await estimateGas(account, chain, rpc, writePolicy).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/estimate failed/);
    expect(error.message).not.toContain("secret-key");
  });
});

describe("gasFor", () => {
  it("is at least the 1,000,000 floor", () => {
    expect(gasFor(1n)).toBe(1_000_000n);
  });

  it("is twice the estimate above the floor", () => {
    expect(gasFor(800_000n)).toBe(1_600_000n);
  });
});

describe("txParamsFor", () => {
  function reader(overrides: Partial<Record<"latest" | "pending" | "balance" | "gasLimit", bigint | number>> = {}): TxReader {
    const { latest = 7, pending = latest, balance = 10n ** 18n, gasLimit = 100_000_000n } = overrides;
    return {
      getBlock: async () => ({ gasLimit }),
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === "latest" ? latest : pending),
      getBalance: async () => balance,
      getGasPrice: async () => 5n,
    } as unknown as TxReader;
  }

  it("uses the latest nonce, the gas policy and the current gas price", async () => {
    await expect(txParamsFor(reader(), account.address, 800_000n)).resolves.toEqual({ nonce: 7, gas: 1_600_000n, gasPrice: 5n });
  });

  it("refuses while a transaction from this signer is pending", async () => {
    await expect(txParamsFor(reader({ pending: 8 }), account.address, 1n)).rejects.toThrow(/pending/);
  });

  it("refuses gas above half the block limit", async () => {
    await expect(txParamsFor(reader({ gasLimit: 1_000_000n }), account.address, 1n)).rejects.toThrow(/half the block/);
  });

  it("refuses when the balance can't cover the gas cap, naming the amounts", async () => {
    await expect(txParamsFor(reader({ balance: 1n }), account.address, 1n)).rejects.toThrow(/balance/);
  });
});
