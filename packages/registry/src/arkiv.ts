// Arkiv I/O on Rabdi. Browser-safe: the extension bundles this file, so no Node imports here.
import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type PublicArkivClient,
  type TxParams,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, eq, gt } from "@arkiv-network/sdk/query";
import { bytes, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema";
import { type AttestationEntry, canonicalJSON, type Hex, type Manifest, type Policy, type SignedAttestation } from "@unforged/core";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { type Account, hexToBytes, http } from "viem";

const PROJECT = "unforged";
const CONTENT_TYPE = "application/gzip";
const PAGE_SIZE = 100; // the most one page can hold
const MAX_PAGES = 50; // a builder can publish anything under their own key, so scans are bounded
const MAX_PAYLOAD_BYTES = 120_000; // formats.md §4

// Unnamed schemas, so entities carry exactly the formats.md attributes and no arkiv.schema tag.
// Readonly entities can never gain an index later, so everything worth querying is indexed now.
const AttestationSchema = defineSchema({
  project: str().indexed(),
  entity_type: str().indexed(),
  dapp: str().indexed(),
  release: str().indexed(),
  commit: str().indexed(),
  manifest_root: str().indexed(),
  recipe_digest: str(),
  swarm_ref: str(),
  content_type: str(),
  payload: bytes(),
});

const PolicySchema = defineSchema({
  project: str().indexed(),
  entity_type: str().indexed(),
  dapp: str().indexed(),
  version: u64().indexed(),
  content_type: str(),
  payload: bytes(),
});

// fromDays(365) is rejected before sending: Rabdi caps a lifetime at 7,884,000 blocks, about 182 days.
const CREATE_OPTIONS = {
  expiration: ExpirationTime.max(),
  flags: { readonly: true, permissionlessExtension: false },
};

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

/** One exact create, runnable against the estimator first and the funded wallet after. */
export type EntityWrite = (client: WriteClient, txParams?: TxParams) => Promise<Published>;

/** Chooses the transaction parameters for an exact write. See tx.ts. */
export type Prepare = (write: EntityWrite) => Promise<TxParams>;

// Fresh reads, and a redirect can't carry a key in the URL path to another host.
const transportOptions = { fetchOptions: { cache: "no-store", redirect: "error" } } satisfies Parameters<typeof http>[1];

/**
 * A reader on Rabdi. Without a key it uses the public endpoint, which is heavily rate
 * limited and can answer HTTP 429. The extension uses this form: it never holds a key.
 */
export const createReadClient = (accessKey = "") =>
  createPublicClient({ chain: rabdi({ accessKey }), cacheTime: 0, transport: http(undefined, transportOptions) });

/** A writer on Rabdi. No transport retries: a retried send is not known to be safe. */
export const createWriteClient = (account: Account, accessKey: string) =>
  createWalletClient({
    account,
    chain: rabdi({ accessKey }),
    cacheTime: 0,
    transport: http(undefined, { ...transportOptions, retryCount: 0 }),
  });

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
  prepare?: Prepare,
): Promise<Published> {
  const values = {
    project: PROJECT,
    entity_type: "attestation",
    content_type: CONTENT_TYPE,
    ...attrs,
    payload: encodeChecked(payload),
  };
  return send(client, (c, tx) => c.createEntity(AttestationSchema, values, CREATE_OPTIONS, tx), prepare);
}

export async function publishPolicy(client: WriteClient, policy: Policy, version: number, prepare?: Prepare): Promise<Published> {
  const values = {
    project: PROJECT,
    entity_type: "policy",
    content_type: CONTENT_TYPE,
    dapp: policy.dapp,
    version: u64(BigInt(version)),
    payload: encodeChecked(policy),
  };
  return send(client, (c, tx) => c.createEntity(PolicySchema, values, CREATE_OPTIONS, tx), prepare);
}

/** Every readonly policy this curator published, for all dapps, highest version first. */
export async function fetchPolicies(client: ReadClient, curator: Hex): Promise<{ version: number; policy: Policy }[]> {
  const rows = await allRows((after) => {
    const query = client
      .select({ $key: true, $creationFlags: true, version: true, payload: true })
      .where([eq("project", PROJECT), eq("entity_type", "policy")])
      .createdBy(curator)
      .orderBy(asc("$key"))
      .limit(PAGE_SIZE);
    if (after !== undefined) query.where(gt("$key", key(after)));
    return query.fetch();
  });

  const policies: { version: number; policy: Policy }[] = [];
  for (const row of rows) {
    const policy = tryDecode<Policy>(row.payload);
    if (row.$creationFlags.readonly && policy !== undefined && row.version?.type === "u64") {
      policies.push({ version: Number(row.version.value), policy });
    }
  }
  return policies.sort((a, b) => b.version - a.version);
}

/**
 * A builder's readonly attestations for a dapp. Lists keys and attributes first, then
 * downloads payloads one by one, skipping `skipKeys` so a sync only pays for what it
 * hasn't seen. Network failures throw: a partial list must not look like a complete one.
 */
export async function fetchAttestations(
  client: ReadClient,
  builder: Hex,
  dapp: string,
  skipKeys: Set<string> = new Set(),
): Promise<(AttestationEntry & { entityKey: string })[]> {
  const rows = await allRows((after) => {
    const query = client
      .select({ $key: true, $creationFlags: true, swarm_ref: true })
      .where([eq("project", PROJECT), eq("entity_type", "attestation"), eq("dapp", dapp)])
      .createdBy(builder)
      .orderBy(asc("$key"))
      .limit(PAGE_SIZE);
    if (after !== undefined) query.where(gt("$key", key(after)));
    return query.fetch();
  });

  const entries: (AttestationEntry & { entityKey: string })[] = [];
  for (const { $key, $creationFlags, swarm_ref } of rows) {
    if (!$creationFlags.readonly || skipKeys.has($key)) continue;
    const { $attributes } = await client.getEntity($key);
    const decoded = tryDecode<{ attestation: SignedAttestation; manifest: Manifest }>($attributes.payload);
    if (decoded === undefined) continue;
    entries.push({
      entityKey: $key,
      creator: builder, // the query is scoped to it, and acceptReleases checks the signer against it
      attestation: decoded.attestation,
      manifest: decoded.manifest,
      swarmRef: swarmRefOf(swarm_ref?.value),
    });
  }
  return entries;
}

/** The key of this creator's attestation for a manifest root, or null. */
export async function findAttestationKey(client: ReadClient, creator: Hex, manifestRoot: string): Promise<Hex | null> {
  const { entities } = await client
    .select({ $key: true })
    .where([eq("project", PROJECT), eq("entity_type", "attestation"), eq("manifest_root", manifestRoot)])
    .createdBy(creator)
    .limit(1)
    .fetch();
  return entities[0]?.$key ?? null;
}

function encodeChecked(body: unknown): Uint8Array {
  const payload = encodePayload(body);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${payload.length} bytes after gzip, over the 120 KB limit`);
  }
  return payload;
}

/** The SDK waits for the receipt and throws if the transaction reverted. */
async function send(client: WriteClient, write: EntityWrite, prepare?: Prepare): Promise<Published> {
  const txParams = await prepare?.(write);
  const { entityKey, txHash } = await write(client, txParams);
  return { entityKey, txHash };
}

/**
 * SDK 1.0 has no cursor, so this walks in $key order, asking for keys after the last seen.
 * Selecting without a schema means a malformed entity can't hide a page: it is returned
 * and dropped by the caller. A short page is the end; a multi-page walk is not one snapshot.
 */
async function allRows<R extends { readonly $key: Hex }>(
  fetchPage: (after: Hex | undefined) => Promise<{ readonly entities: readonly R[] }>,
): Promise<R[]> {
  const rows: R[] = [];
  let after: Hex | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { entities } = await fetchPage(after);
    rows.push(...entities);
    if (entities.length < PAGE_SIZE) return rows;

    const last = entities[entities.length - 1]!.$key;
    if (after !== undefined && last.toLowerCase() <= after.toLowerCase()) throw new Error("query keyset did not advance");
    after = last;
  }
  throw new Error(`more than the page budget of ${MAX_PAGES} pages; refusing a partial list`);
}

/** Anyone can publish garbage under their own key; undecodable entities count as absent. */
function tryDecode<T>(attribute: { type: string; value: unknown } | undefined): T | undefined {
  if (attribute?.type !== "bytes" || typeof attribute.value !== "string") return undefined;
  try {
    return decodePayload<T>(hexToBytes(attribute.value as Hex));
  } catch {
    return undefined;
  }
}

function swarmRefOf(value: unknown): string | null {
  return typeof value === "string" && value !== "none" ? value : null;
}
