#!/usr/bin/env node
import { Command } from "commander";
import { config } from "dotenv";
import { runAttest } from "./attest.js";
import { runBuild } from "./build.js";
import { CliError, EXIT_BUILD_FAILED } from "./errors.js";
import { runPolicy } from "./policy.js";
import { runPublish } from "./publish.js";
import { explorerAddressUrl, explorerTxUrl } from "./registry.js";

// Signing keys and the Rabdi access key come from the environment or a git-ignored .env in the
// working directory. `unforged build` passes install and build scripts an allowlisted env, so they never see them.
config({ quiet: true });

const program = new Command("unforged").description("Rebuild dapps from source and attest the result");

program
  .command("build")
  .description("Build a recipe and write manifest.json and build.log to the current directory")
  .argument("<recipe>", "path to the recipe YAML")
  .option("--check", "build twice from a clean checkout and exit 3 if the manifests differ")
  .option("--allow-node-mismatch", "build even if node --version doesn't match recipe.node")
  .action(async (recipe: string, options: { check?: boolean; allowNodeMismatch?: boolean }) => {
    console.log(await runBuild(recipe, options));
  });

program
  .command("attest")
  .description("Sign a statement for a manifest with BUILDER_PRIVATE_KEY and write attestation.json")
  .argument("<manifest>", "path to manifest.json")
  .argument("<recipe>", "path to the recipe YAML the manifest was built from")
  .action(async (manifest: string, recipe: string) => {
    const result = await runAttest(manifest, recipe);
    console.log(`wrote ${result.path}`);
    console.log(`manifest root: ${result.manifestRoot}`);
    console.log(`builder:       ${result.builder}`);
  });

program
  .command("publish")
  .description("Create the attestation entity on Arkiv. Does nothing if this builder already published the root")
  .argument("<attestation>", "path to attestation.json")
  .argument("<manifest>", "path to manifest.json")
  .action(async (attestation: string, manifest: string) => {
    const result = await runPublish(attestation, manifest);
    console.log(result.created ? "published attestation" : "already published");
    console.log(`entity key: ${result.entityKey}`);
    if (result.created) console.log(`tx:         ${explorerTxUrl(result.txHash)}`);
    console.log(`builder:    ${explorerAddressUrl(result.creator)}`);
  });

program
  .command("policy")
  .description("Publish a policy with CURATOR_PRIVATE_KEY as the dapp's next version")
  .argument("<policy>", "path to policy.json")
  .action(async (policy: string) => {
    const result = await runPolicy(policy);
    console.log(`published policy version ${result.version}`);
    console.log(`entity key: ${result.entityKey}`);
    console.log(`tx:         ${explorerTxUrl(result.txHash)}`);
    console.log(`curator:    ${explorerAddressUrl(result.curator)}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`unforged: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof CliError ? error.exitCode : EXIT_BUILD_FAILED;
});
