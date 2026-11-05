// Explicit transaction parameters for Rabdi writes, following Arkiv's write-safety guidance:
// default gas estimation has been measured reverting from gas exhaustion there.
import { createWalletClient, type PublicArkivClient, type TxParams } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { custom, http, type LocalAccount, MethodNotFoundRpcError } from "viem";
import { getGasPrice } from "viem/actions";
import { createReadClient, type EntityWrite, type Prepare, type WriteClient } from "./arkiv.js";

const RABDI_CHAIN_ID = 7794095n;
const GAS_FLOOR = 1_000_000n; // Arkiv's measured starting cap for one operation

const ESTIMATE_READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
]);

type Rpc = Parameters<typeof custom>[0];
type RabdiChain = ReturnType<typeof rabdi>;

export type TxReader = Pick<PublicArkivClient, "getBlock" | "getTransactionCount" | "getBalance"> & {
  getGasPrice(): Promise<bigint>;
};

/**
 * The node's gas estimate for this exact write. It runs against a wallet that can't sign
 * and a transport that only forwards reads, so nothing can be broadcast. Errors carry
 * fixed text only, because a transport error can quote the keyed RPC URL.
 */
export async function estimateGas(
  account: LocalAccount,
  chain: RabdiChain,
  rpc: Rpc,
  write: (client: WriteClient) => Promise<unknown>,
): Promise<bigint> {
  const failed = () => new Error("gas estimate failed; nothing was sent");

  const chainId = await rpc.request({ method: "eth_chainId" }).catch(() => {
    throw failed();
  });
  if (BigInt(chainId as string) !== RABDI_CHAIN_ID) throw new Error("the RPC endpoint is not Rabdi; nothing was sent");

  let estimate: bigint | undefined;
  const transport = custom(
    {
      async request(args: { method: string; params?: unknown[] }) {
        if (args.method === "eth_fillTransaction") throw new MethodNotFoundRpcError(failed());
        if (!ESTIMATE_READS.has(args.method)) throw failed();
        if (args.method !== "eth_estimateGas") return rpc.request(args);

        const result = await rpc.request({ method: args.method, params: [args.params?.[0], "latest"] });
        estimate = BigInt(result as string);
        throw new Error("estimate captured"); // stops the SDK here, before any signing
      },
    },
    { retryCount: 0 },
  );
  const unsigned: LocalAccount = {
    ...account,
    signTransaction: async () => {
      throw failed();
    },
  };

  await write(createWalletClient({ account: unsigned, chain, transport })).catch(() => {});
  if (estimate === undefined || estimate <= 0n) throw failed();
  return estimate;
}

/** The larger of the floor and twice the estimate. */
export function gasFor(estimate: bigint): bigint {
  const doubled = 2n * estimate;
  return doubled > GAS_FLOOR ? doubled : GAS_FLOOR;
}

/** Latest nonce, gas and current price, once the write is known to fit and be affordable. */
export async function txParamsFor(reader: TxReader, address: LocalAccount["address"], estimate: bigint): Promise<TxParams> {
  const gas = gasFor(estimate);
  const { gasLimit } = await reader.getBlock({ blockTag: "latest" });
  if (gas > gasLimit / 2n) throw new Error(`gas ${gas} is above half the block limit of ${gasLimit}; nothing was sent`);

  const nonce = await reader.getTransactionCount({ address, blockTag: "latest" });
  const pending = await reader.getTransactionCount({ address, blockTag: "pending" });
  if (pending !== nonce) throw new Error(`${address} has a pending transaction; resolve it first. Nothing was sent`);

  const gasPrice = await reader.getGasPrice();
  const balance = await reader.getBalance({ address });
  if (gas * gasPrice > balance) {
    throw new Error(`${address} has a balance of ${balance} wei, below the gas cap of ${gas * gasPrice} wei. Nothing was sent`);
  }
  return { nonce, gas, gasPrice };
}

/** Prepares each write on Rabdi: estimate the exact operation unsigned, then choose its parameters. */
export function rabdiPrepare(account: LocalAccount, accessKey: string): Prepare {
  const chain = rabdi({ accessKey });
  const rpc = http(undefined, { retryCount: 0, fetchOptions: { cache: "no-store", redirect: "error" } })({ chain });
  const client = createReadClient(accessKey);
  const reader: TxReader = {
    getBlock: client.getBlock,
    getTransactionCount: client.getTransactionCount,
    getBalance: client.getBalance,
    getGasPrice: () => getGasPrice(client),
  };

  return async (write: EntityWrite) => txParamsFor(reader, account.address, await estimateGas(account, chain, rpc, write));
}
