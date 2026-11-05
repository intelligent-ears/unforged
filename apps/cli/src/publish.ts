import { acceptReleases, type Hex, type Manifest, manifestRoot, type SignedAttestation } from "@unforged/core";
import { findAttestationKey, publishAttestation } from "@unforged/registry";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";
import { readJson, readManifest } from "./files.js";
import { accountFromEnv } from "./keys.js";
import { type Clients, registryCall, tiramisuClients } from "./registry.js";

const NO_SWARM_REF = "none"; // until uploads exist (M8)

export type PublishClients = Clients;

export interface PublishOptions {
  env?: NodeJS.ProcessEnv;
  clients?: Clients;
}

export type PublishResult =
  | { created: true; entityKey: Hex; txHash: Hex; creator: Hex }
  | { created: false; entityKey: Hex; creator: Hex };

/** Creates the attestation entity, unless this creator already has one for the manifest root. */
export async function runPublish(attestationPath: string, manifestPath: string, options: PublishOptions = {}): Promise<PublishResult> {
  const account = accountFromEnv("BUILDER_PRIVATE_KEY", options.env ?? process.env);
  const attestation = readJson(attestationPath) as SignedAttestation;
  const manifest = readManifest(manifestPath);
  await assertAcceptable(attestation, manifest, account.address);

  const { read, write } = options.clients ?? tiramisuClients(account);
  const root = await manifestRoot(manifest);

  const existing = await registryCall(() => findAttestationKey(read, account.address, root));
  if (existing !== null) return { created: false, entityKey: existing, creator: account.address };

  const { entityKey, txHash } = await registryCall(() =>
    publishAttestation(write, { attestation, manifest }, {
      dapp: manifest.dapp,
      release: manifest.release,
      commit: manifest.commit,
      manifest_root: root,
      recipe_digest: attestation.statement.predicate.recipeDigest,
      swarm_ref: NO_SWARM_REF,
    }),
  );
  return { created: true, entityKey, txHash, creator: account.address };
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
