import { createReadClient, createWriteClient, type Prepare, rabdiPrepare, type ReadClient, type WriteClient } from "@unforged/registry";
import type { LocalAccount } from "viem";
import { CliError, EXIT_REGISTRY } from "./errors.js";
import { accessKeyFromEnv } from "./keys.js";

const EXPLORER = "https://rabdi.explorer.arkiv.network";

export const explorerTxUrl = (txHash: string) => `${EXPLORER}/tx/${txHash}`;
export const explorerAddressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export interface Clients {
  read: ReadClient;
  write: WriteClient;
  prepare?: Prepare;
}

export function rabdiClients(account: LocalAccount, env: NodeJS.ProcessEnv): Clients {
  const accessKey = accessKeyFromEnv(env);
  return {
    read: createReadClient(accessKey),
    write: createWriteClient(account, accessKey),
    prepare: rabdiPrepare(account, accessKey),
  };
}

/** Runs a registry read or estimate, reporting failure with the registry exit code. */
export async function registryCall<T>(call: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new CliError(EXIT_REGISTRY, `registry error: ${safeMessage(error, env)}`);
  }
}

/** A failed write may still have been sent, so the message says to look before trying again. */
export async function registryWrite<T>(call: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const { txHash } = error as { txHash?: unknown };
    const hash = typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? ` (tx ${txHash})` : "";
    throw new CliError(
      EXIT_REGISTRY,
      `registry error: ${safeMessage(error, env)}${hash}. If a transaction was sent, check it on ${EXPLORER} before retrying`,
    );
  }
}

/**
 * The access key is a path segment of the RPC URL, and viem quotes that URL in its errors.
 * So: the first line only, no cause, every URL removed, and the key removed in both spellings.
 */
function safeMessage(error: unknown, env: NodeJS.ProcessEnv): string {
  const { shortMessage, message } = (error ?? {}) as { shortMessage?: unknown; message?: unknown };
  const text = String(shortMessage ?? message ?? "unknown failure");
  const key = env.ARKIV_API_KEY?.trim();

  let safe = (text.split("\n")[0] ?? "").replace(/\b(?:https?|wss?):\/\/\S+/g, "[url]");
  if (key) safe = safe.replaceAll(key, "[redacted]").replaceAll(encodeURIComponent(key), "[redacted]");
  return safe;
}
