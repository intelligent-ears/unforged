import { type Hex, type Policy, type SignedPolicy, signPolicy, verifyPolicy } from "@unforged/core";
import { decodePayload, encodePayload, fetchPolicies, publishPolicy } from "@unforged/registry";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";
import { readJson } from "./files.js";
import { accountFromEnv } from "./keys.js";
import { type Clients, rabdiClients, registryCall, registryWrite } from "./registry.js";

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "must be an address")
  .transform((value) => getAddress(value));

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex");

const policySchema = z
  .strictObject({
    dapp: z.string().regex(/^[a-z0-9-]+$/),
    origins: z.array(z.string().regex(/^https?:\/\/[^/\s]+$/)).min(1),
    repo: z.string().regex(/^https:\/\/\S+$/),
    builders: z.array(address).min(1),
    threshold: z.int().min(1),
    acceptLatest: z.int().min(1),
    thirdParty: z.record(z.string(), z.record(z.string(), sha256)),
    recovery: z.strictObject({ gateway: z.string().min(1) }),
    configPins: z.record(z.string().regex(/^\//, "must be a served path starting with /"), sha256).optional(),
  })
  .refine((policy) => policy.threshold <= new Set(policy.builders).size, {
    path: ["threshold"],
    message: "is above the number of distinct builders, so no release could ever be accepted",
  });

export interface PolicyOptions {
  env?: NodeJS.ProcessEnv;
  clients?: Clients;
}

export interface PolicyResult {
  entityKey: Hex;
  txHash: Hex;
  version: number;
  curator: Hex;
}

/** Signs a policy with the curator key and publishes it as the next version for its dapp. */
export async function runPolicy(policyPath: string, options: PolicyOptions = {}): Promise<PolicyResult> {
  const { env = process.env } = options;
  const account = accountFromEnv("CURATOR_PRIVATE_KEY", env);
  const policy = parsePolicy(readJson(policyPath), policyPath);
  const { read, write, prepare } = options.clients ?? rabdiClients(account, env);

  const published = await registryCall(() => fetchPolicies(read, account.address), env);
  const versions = published.filter((p) => p.policy.dapp === policy.dapp).map((p) => p.version);
  const version = Math.max(0, ...versions) + 1;

  const signed = await signPolicy(policy, account);
  await checkSigned(signed, account.address);
  const { entityKey, txHash } = await registryWrite(() => publishPolicy(write, signed, version, prepare), env);
  return { entityKey, txHash, version, curator: account.address };
}

function parsePolicy(value: unknown, path: string): Policy {
  const result = policySchema.safeParse(value);
  if (!result.success) throw new CliError(EXIT_BAD_INPUT, `invalid policy ${path}:\n${z.prettifyError(result.error)}`);
  return result.data as Policy;
}

/** Verifies the payload exactly as readers will decode it, so a policy nobody would accept is never sent. */
async function checkSigned(signed: SignedPolicy, curator: Hex): Promise<void> {
  const decoded = decodePayload<SignedPolicy>(encodePayload(signed));
  if (!(await verifyPolicy(decoded, curator))) {
    throw new CliError(EXIT_BAD_INPUT, "the signed policy does not verify against the curator key; nothing was published");
  }
}
