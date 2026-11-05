import { acceptReleases, type Hex, type Manifest, manifestRoot, type SignedAttestation } from "@unforged/core";
import { findAttestation, publishAttestation } from "@unforged/registry";
import { CliError, EXIT_BAD_INPUT, EXIT_MIRROR_MISMATCH } from "./errors.js";
import { readJson, readManifest } from "./files.js";
import { accountFromEnv } from "./keys.js";
import { checkMirror, formatMirrorReport, mirrorPassed, NO_MIRROR_REF } from "./mirror-check.js";
import { type Clients, rabdiClients, registryCall, registryWrite } from "./registry.js";

export type PublishClients = Clients;

export interface PublishOptions {
  env?: NodeJS.ProcessEnv;
  clients?: Clients;
  mirrorRef?: string;
  gateway?: string;
  fetch?: typeof globalThis.fetch;
}

export type PublishResult =
  | { created: true; entityKey: Hex; txHash: Hex; creator: Hex }
  | { created: false; entityKey: Hex; creator: Hex; swarmRef: string | null };

/**
 * Creates the attestation entity, unless this creator already has one for the manifest root.
 * With a mirror, it first checks the mirror byte for byte and refuses to publish unless it matches.
 * An existing entity is readonly, so it keeps its ref: the result says which one that is.
 */
export async function runPublish(attestationPath: string, manifestPath: string, options: PublishOptions = {}): Promise<PublishResult> {
  const { env = process.env } = options;
  const account = accountFromEnv("BUILDER_PRIVATE_KEY", env);
  const attestation = readJson(attestationPath) as SignedAttestation;
  const manifest = readManifest(manifestPath);
  assertBothOrNeither(options);
  await assertAcceptable(attestation, manifest, account.address);

  const { read, write, prepare } = options.clients ?? rabdiClients(account, env);
  if (options.mirrorRef !== undefined) await assertMirrorMatches(manifest, options);
  const root = await manifestRoot(manifest);

  const existing = await registryCall(() => findAttestation(read, account.address, root), env);
  if (existing !== null) return { created: false, ...existing, creator: account.address };

  const attrs = {
    dapp: manifest.dapp,
    release: manifest.release,
    commit: manifest.commit,
    manifest_root: root,
    recipe_digest: attestation.statement.predicate.recipeDigest,
    swarm_ref: options.mirrorRef ?? NO_MIRROR_REF,
  };
  const { entityKey, txHash } = await registryWrite(() => publishAttestation(write, { attestation, manifest }, attrs, prepare), env);
  return { created: true, entityKey, txHash, creator: account.address };
}

function assertBothOrNeither({ mirrorRef, gateway }: PublishOptions): void {
  if ((mirrorRef === undefined) !== (gateway === undefined)) {
    throw new CliError(EXIT_BAD_INPUT, "--mirror-ref and --gateway must be given together");
  }
}

async function assertMirrorMatches(manifest: Manifest, { mirrorRef, gateway, fetch }: PublishOptions): Promise<void> {
  const report = await checkMirror(manifest, gateway!, mirrorRef!, { fetch });
  if (!mirrorPassed(report)) {
    throw new CliError(EXIT_MIRROR_MISMATCH, `mirror check failed, nothing published:\n${formatMirrorReport(report)}`);
  }
}

/** Runs the extension's own checks with a one-builder policy, so gas is never spent on an entity it would drop. */
async function assertAcceptable(attestation: SignedAttestation, manifest: Manifest, creator: Hex): Promise<void> {
  const accepted = await acceptReleases(
    {
      dapp: manifest.dapp,
      origins: [],
      repo: attestation.statement?.predicate?.repo,
      builders: [creator],
      threshold: 1,
      acceptLatest: 1,
      thirdParty: {},
      recovery: { gateway: "" },
    },
    [{ creator, attestation, manifest, swarmRef: null }],
  );
  if (accepted.length === 0) {
    throw new CliError(EXIT_BAD_INPUT, `attestation does not verify against this manifest and signer ${creator}`);
  }
}
