import { createReadClient, createWriteClient, type ReadClient, type WriteClient } from "@unforged/registry";
import type { Account } from "viem";
import { CliError, EXIT_REGISTRY } from "./errors.js";

const EXPLORER = "https://tiramisu.explorer.arkiv.network";

export const explorerTxUrl = (txHash: string) => `${EXPLORER}/tx/${txHash}`;
export const explorerAddressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export interface Clients {
  read: ReadClient;
  write: WriteClient;
}

export const tiramisuClients = (account: Account): Clients => ({
  read: createReadClient(),
  write: createWriteClient(account),
});

/** Runs a registry call, reporting any failure with the registry exit code. */
export async function registryCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const { shortMessage, message } = error as { shortMessage?: string; message?: string };
    throw new CliError(EXIT_REGISTRY, `registry error: ${shortMessage ?? message ?? String(error)}`);
  }
}
