import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";

export type KeyName = "BUILDER_PRIVATE_KEY" | "CURATOR_PRIVATE_KEY";

/**
 * The signing account for a key held in the environment. Errors name the variable and
 * never its value, and the library's own error is discarded because it can quote the input.
 */
export function accountFromEnv(name: KeyName, env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const value = env[name]?.trim();
  if (!value) throw new CliError(EXIT_BAD_INPUT, `${name} is not set`);

  const invalid = new CliError(EXIT_BAD_INPUT, `${name} is not a valid private key`);
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw invalid;
  try {
    return privateKeyToAccount(hex as `0x${string}`);
  } catch {
    throw invalid;
  }
}

/** The Rabdi RPC access key. Only the CLI uses one; the extension reads keyless. */
export function accessKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ARKIV_ACCESS_KEY?.trim();
  if (!value) throw new CliError(EXIT_BAD_INPUT, "ARKIV_ACCESS_KEY is not set");
  return value;
}
