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
import {
  type AttestationEntry,
  canonicalJSON,
  type Hex,
  type Manifest,
  type Policy,
  sameAddress,
  type SignedAttestation,
  type SignedPolicy,
  verifyPolicy,
} from "@unforged/core";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { type Account, hexToBytes, http, HttpRequestError } from "viem";

const PROJECT = "unforged";
const CONTENT_TYPE = "application/gzip";
const PAGE_SIZE = 100; // the most one page can hold
const MAX_PAGES = 50; // a builder can publish anything under their own key, so scans are bounded
const MAX_PAYLOAD_BYTES = 120_000; // formats.md §4
const MAX_ATTEMPTS = 6; // with the delays below, about 15 seconds of waiting before giving up
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

// One schema per entity kind. Unnamed, so entities carry exactly the formats.md attributes and no arkiv.schema tag.
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

/** What a read runs against: a client, or an access key to make one with. No key or "" means the public RPC. */
export type ReadSource = ReadClient | { accessKey?: string };

export interface AttestationAttributes {
  dapp: string;
  release: string;
  commit: string;
  manifest_root: string;
  recipe_digest: string;
  swarm_ref: string; // mirror reference (a folder on the policy's recovery.gateway), or "none"
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
 * viem's retries are off because withBackoff handles 429s, and the two would multiply.
 */
export const createReadClient = (accessKey = "") =>
  createPublicClient({
    chain: rabdi({ accessKey }),
    cacheTime: 0,
    transport: http(undefined, { ...transportOptions, retryCount: 0 }),
  });

/**
 * Runs one request, retrying on HTTP 429 after 0.5s, 1s, 2s, 4s and 8s, or after the server's
 * Retry-After. Any other failure, or a 429 on the last attempt, throws: a read that couldn't
 * finish must not look like an empty result.
 */
export async function withBackoff<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void> = delay): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const limited = rateLimitError(error);
      if (limited === undefined || attempt === MAX_ATTEMPTS) throw error;
      await sleep(retryAfterMs(limited) ?? BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

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

/**
 * Publishes a curator-signed policy (formats.md §4). The caller signs; this only stores. The
 * version attribute is the signed version, so the two can't disagree.
 */
export async function publishPolicy(client: WriteClient, signed: SignedPolicy, prepare?: Prepare): Promise<Published> {
  const values = {
    project: PROJECT,
    entity_type: "policy",
    content_type: CONTENT_TYPE,
    dapp: signed.policy.dapp,
    version: u64(BigInt(signed.version)),
    payload: encodeChecked({ policy: signed.policy, version: signed.version, signature: signed.signature }),
  };
  return send(client, (c, tx) => c.createEntity(PolicySchema, values, CREATE_OPTIONS, tx), prepare);
}

/**
 * Every readonly policy this curator created and signed, for all dapps, highest version first.
 * Arkiv is untrusted storage: a row counts only if its $creator is the curator, the payload's
 * signature over { policy, version } recovers to the curator, and that signed version is the
 * entity's version attribute. Unsigned, mis-signed, relabelled or malformed rows are dropped.
 */
export async function fetchPolicies(source: ReadSource, curator: Hex): Promise<{ version: number; policy: Policy }[]> {
  const client = readClientFor(source);
  const rows = await allRows((after) => {
    const query = client
      .select({ $key: true, $creator: true, $creationFlags: true, version: true, payload: true })
      .where([eq("project", PROJECT), eq("entity_type", "policy")])
      .createdBy(curator)
      .orderBy(asc("$key"))
      .limit(PAGE_SIZE);
    if (after !== undefined) query.where(gt("$key", key(after)));
    return query.fetch();
  });

  const policies: { version: number; policy: Policy }[] = [];
  for (const row of rows) {
    if (!row.$creationFlags.readonly || row.version?.type !== "u64") continue;
    if (typeof row.$creator !== "string" || !sameAddress(row.$creator, curator)) continue;
    const signed = tryDecode<SignedPolicy>(row.payload);
    if (signed === undefined || !(await verifyPolicy(signed, curator))) continue;
    if (BigInt(signed.version) !== row.version.value) continue; // verifyPolicy checked it is a safe integer
    policies.push({ version: signed.version, policy: signed.policy });
  }
  return policies.sort((a, b) => b.version - a.version);
}

/**
 * A builder's readonly attestations for a dapp. Lists keys and attributes first, then
 * downloads payloads one by one, skipping `skipKeys` so a sync only pays for what it
 * hasn't seen. Network failures throw: a partial list must not look like a complete one.
 */
export async function fetchAttestations(
  source: ReadSource,
  builder: Hex,
  dapp: string,
  skipKeys: Set<string> = new Set(),
): Promise<(AttestationEntry & { entityKey: string })[]> {
  const client = readClientFor(source);
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
    const { $attributes } = await withBackoff(() => client.getEntity($key));
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

/** This creator's attestation for a manifest root, or null. Publish's idempotency check. */
export async function findAttestation(source: ReadSource, creator: Hex, manifestRoot: string): Promise<{ entityKey: Hex; swarmRef: string | null } | null> {
  const client = readClientFor(source);
  const { entities } = await withBackoff(() =>
    client
      .select({ $key: true, swarm_ref: true })
      .where([eq("project", PROJECT), eq("entity_type", "attestation"), eq("manifest_root", manifestRoot)])
      .createdBy(creator)
      .limit(1)
      .fetch(),
  );
  const entity = entities[0];
  return entity === undefined ? null : { entityKey: entity.$key, swarmRef: swarmRefOf(entity.swarm_ref?.value) };
}

function readClientFor(source: ReadSource): ReadClient {
  return "select" in source ? source : createReadClient(source.accessKey);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The HTTP 429 in an error's cause chain, if there is one. */
function rateLimitError(error: unknown): HttpRequestError | undefined {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    if (current instanceof HttpRequestError && current.status === 429) return current;
    current = current.cause;
  }
  return undefined;
}

function retryAfterMs(error: HttpRequestError): number | undefined {
  const header = error.headers?.get("Retry-After");
  return header != null && /^\d+$/.test(header) ? Math.min(Number(header) * 1000, MAX_DELAY_MS) : undefined;
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
    const { entities } = await withBackoff(() => fetchPage(after));
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
