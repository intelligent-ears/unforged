// Arkiv I/O. Browser-safe: the extension bundles this file, so no Node imports here.
import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type PublicArkivClient,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/attr";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { eq } from "@arkiv-network/sdk/query";
import { type AttestationEntry, canonicalJSON, type Hex, type Manifest, type Policy, type SignedAttestation } from "@unforged/core";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { type Account, http } from "viem";

const PROJECT = "unforged";
const PAGE_SIZE = 200; // the most one page can hold
const MAX_PAYLOAD_BYTES = 120_000; // formats.md §4

export type ReadClient = Pick<PublicArkivClient, "select" | "getEntity">;
export type WriteClient = Pick<WalletArkivClient, "createEntity">;

export interface AttestationAttributes {
  dapp: string;
  release: string;
  commit: string;
  manifest_root: string;
  recipe_digest: string;
  swarm_ref: string; // 64-hex, or "none"
}

export interface Published {
  entityKey: Hex;
  txHash: Hex;
}

export const createReadClient = () => createPublicClient({ chain: tiramisu, transport: http() });

export const createWriteClient = (account: Account) => createWalletClient({ chain: tiramisu, account, transport: http() });

/** gzip(canonicalJSON(value)). mtime is fixed so that equal values encode to equal bytes. */
export function encodePayload(value: unknown): Uint8Array {
  return gzipSync(strToU8(canonicalJSON(value)), { mtime: 0 });
}

export function decodePayload<T>(payload: Uint8Array): T {
  return JSON.parse(strFromU8(gunzipSync(payload))) as T;
}

export async function publishAttestation(
  client: WriteClient,
  payload: { attestation: SignedAttestation; manifest: Manifest },
  attrs: AttestationAttributes,
): Promise<Published> {
  return createEntity(client, payload, { entity_type: "attestation", ...attrs });
}

export async function publishPolicy(client: WriteClient, policy: Policy, version: number): Promise<Published> {
  return createEntity(client, policy, { entity_type: "policy", dapp: policy.dapp, version: u64(BigInt(version)) });
}

/** Every policy this curator published, for all dapps, highest version first. */
export async function fetchPolicies(client: ReadClient, curator: Hex): Promise<{ version: number; policy: Policy }[]> {
  const page = await client
    .select({ payload: true, attributes: true })
    .where(eq("project", PROJECT), eq("entity_type", "policy"))
    .createdBy(curator)
    .limit(PAGE_SIZE)
    .fetch();

  const policies: { version: number; policy: Policy }[] = [];
  for (const entity of await allEntities(page)) {
    const policy = tryDecode<Policy>(entity.payload);
    const version = entity.attributes.version?.value;
    if (policy !== undefined && typeof version === "bigint") policies.push({ version: Number(version), policy });
  }
  return policies.sort((a, b) => b.version - a.version);
}

/**
 * A builder's attestations for a dapp. Lists keys and attributes first, then downloads
 * payloads one by one, skipping `skipKeys` so a sync only pays for what it hasn't seen.
 * Network failures throw: a partial list must not look like a complete one.
 */
export async function fetchAttestations(
  client: ReadClient,
  builder: Hex,
  dapp: string,
  skipKeys: Set<string> = new Set(),
): Promise<(AttestationEntry & { entityKey: string })[]> {
  const page = await client
    .select({ key: true, attributes: true })
    .where(eq("project", PROJECT), eq("entity_type", "attestation"), eq("dapp", dapp))
    .createdBy(builder)
    .limit(PAGE_SIZE)
    .fetch();

  const entries: (AttestationEntry & { entityKey: string })[] = [];
  for (const { key, attributes } of await allEntities(page)) {
    if (skipKeys.has(key)) continue;
    const { payload } = await client.getEntity(key);
    const decoded = tryDecode<{ attestation: SignedAttestation; manifest: Manifest }>(payload);
    if (decoded === undefined) continue;
    entries.push({
      entityKey: key,
      creator: builder, // the query is scoped to it, and acceptReleases checks the signer against it
      attestation: decoded.attestation,
      manifest: decoded.manifest,
      swarmRef: swarmRefOf(attributes.swarm_ref?.value),
    });
  }
  return entries;
}

/** The key of this creator's attestation for a manifest root, or null. */
export async function findAttestationKey(client: ReadClient, creator: Hex, manifestRoot: string): Promise<Hex | null> {
  const { entities } = await client
    .select({ key: true })
    .where(eq("project", PROJECT), eq("entity_type", "attestation"), eq("manifest_root", manifestRoot))
    .createdBy(creator)
    .limit(1)
    .fetch();
  return entities[0]?.key ?? null;
}

type CreateParams = Parameters<WriteClient["createEntity"]>[0];

/** The SDK waits for the receipt and throws if the transaction reverted. */
async function createEntity(client: WriteClient, body: unknown, attributes: CreateParams["attributes"]): Promise<Published> {
  const payload = encodePayload(body);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${payload.length} bytes after gzip, over the 120 KB limit`);
  }
  const { entityKey, txHash } = await client.createEntity({
    payload,
    contentType: "application/gzip",
    attributes: { project: PROJECT, ...attributes },
    expires: ExpirationTime.fromDays(365),
    flags: { readonly: true, permissionlessExtension: false },
  });
  return { entityKey, txHash };
}

interface Page<T> {
  entities: readonly T[];
  hasNextPage(): boolean;
  next(): Promise<Page<T>>;
}

async function allEntities<T>(first: Page<T>): Promise<T[]> {
  const entities = [...first.entities];
  for (let page = first; page.hasNextPage(); ) {
    page = await page.next();
    entities.push(...page.entities);
  }
  return entities;
}

/** Anyone can publish garbage under their own key; undecodable entities count as absent. */
function tryDecode<T>(payload: Uint8Array | undefined): T | undefined {
  if (payload === undefined) return undefined;
  try {
    return decodePayload<T>(payload);
  } catch {
    return undefined;
  }
}

function swarmRefOf(value: unknown): string | null {
  return typeof value === "string" && value !== "none" ? value : null;
}
