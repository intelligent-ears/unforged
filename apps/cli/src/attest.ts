import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStatement,
  canonicalJSON,
  type Hex,
  type Manifest,
  manifestRoot,
  type Recipe,
  type SignedAttestation,
  statementDigest,
  verifyAttestation,
} from "@unforged/core";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";
import { readManifest, readText } from "./files.js";
import { accountFromEnv } from "./keys.js";
import { parseRecipe } from "./recipe.js";

export interface AttestOptions {
  /** Where attestation.json goes. */
  outDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AttestResult {
  path: string;
  manifestRoot: string;
  builder: Hex;
}

/** Signs a statement that this recipe produced this manifest, and checks the result with core. */
export async function runAttest(manifestPath: string, recipePath: string, options: AttestOptions = {}): Promise<AttestResult> {
  const { outDir = process.cwd(), env = process.env } = options;
  const account = accountFromEnv("BUILDER_PRIVATE_KEY", env);
  const manifest = readManifest(manifestPath);
  const recipe = parseRecipe(readText(recipePath));
  assertBuiltFrom(manifest, recipe);

  const statement = await buildStatement(manifest, recipe, account.address, {
    node: process.versions.node,
    packageManager: recipe.packageManager,
    os: `${process.platform}-${process.arch}`,
  });
  const signature = await account.signMessage({ message: { raw: await statementDigest(statement) } });
  const attestation: SignedAttestation = { statement, signature };

  const path = join(outDir, "attestation.json");
  writeFileSync(path, canonicalJSON(attestation));
  if (!(await verifyAttestation(attestation, account.address))) {
    throw new CliError(EXIT_BAD_INPUT, "the attestation just written does not verify");
  }
  return { path, manifestRoot: await manifestRoot(manifest), builder: account.address };
}

/** A manifest from another recipe must not be attested with this recipe's digest. */
function assertBuiltFrom(manifest: Manifest, recipe: Recipe): void {
  const expected = { dapp: recipe.dapp, release: recipe.release, commit: recipe.commit, config: recipe.configFiles };
  for (const [field, value] of Object.entries(expected)) {
    if (canonicalJSON(manifest[field as keyof Manifest]) !== canonicalJSON(value)) {
      throw new CliError(EXIT_BAD_INPUT, `manifest ${field} doesn't match the recipe`);
    }
  }
}
