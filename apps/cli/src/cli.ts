#!/usr/bin/env node
import { Command } from "commander";
import { config } from "dotenv";
import { runAttest } from "./attest.js";
import { runBuild } from "./build.js";
import { CliError, EXIT_BUILD_FAILED, EXIT_MIRROR_MISMATCH } from "./errors.js";
import { readManifest } from "./files.js";
import { checkMirror, formatMirrorReport, mirrorPassed } from "./mirror-check.js";
import { runPolicy } from "./policy.js";
import { runPublish } from "./publish.js";
import { explorerAddressUrl, explorerTxUrl } from "./registry.js";

// Signing keys and the Rabdi access key come from the environment or a git-ignored .env in the
// working directory. `unforged build` passes install and build scripts an allowlisted env, so they never see them.
config({ quiet: true });

const program = new Command("unforged").description("Rebuild dapps from source and attest the result");

program
  .command("build")
  .description("Build a recipe and write manifest.json, build-info.json and build.log to the current directory")
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
  .option("--toolchain-from-host", "with no build-info.json beside the manifest, record this machine and time instead")
  .action(async (manifest: string, recipe: string, options: { toolchainFromHost?: boolean }) => {
    const result = await runAttest(manifest, recipe, options);
    console.log(`wrote ${result.path}`);
    console.log(`manifest root: ${result.manifestRoot}`);
    console.log(`builder:       ${result.builder}`);
  });

program
  .command("mirror-check")
  .description("Fetch a mirror's files and compare them with a manifest. Exits 3 unless all match")
  .argument("<manifest>", "path to manifest.json")
  .requiredOption("--gateway <url>", 'mirror base URL: https, ending in "/"')
  .requiredOption("--ref <name>", "the build's folder on the gateway")
  .action(async (manifest: string, options: { gateway: string; ref: string }) => {
    const report = await checkMirror(readManifest(manifest), options.gateway, options.ref);
    console.log(formatMirrorReport(report));
    if (!mirrorPassed(report)) process.exitCode = EXIT_MIRROR_MISMATCH;
  });

program
  .command("publish")
  .description("Create the attestation entity on Arkiv. Does nothing if this builder already published the root")
  .argument("<attestation>", "path to attestation.json")
  .argument("<manifest>", "path to manifest.json")
  .option("--mirror-ref <name>", "record this mirror in the attestation, after checking it byte for byte (needs --gateway)")
  .option("--gateway <url>", 'mirror base URL: https, ending in "/" (needs --mirror-ref)')
  .action(async (attestation: string, manifest: string, options: { mirrorRef?: string; gateway?: string }) => {
    const result = await runPublish(attestation, manifest, options);
    console.log(result.created ? "published attestation" : "already published");
    console.log(`entity key: ${result.entityKey}`);
    if (result.created) console.log(`tx:         ${explorerTxUrl(result.txHash)}`);
    console.log(`builder:    ${explorerAddressUrl(result.creator)}`);
    if (!result.created && options.mirrorRef !== undefined && result.swarmRef !== options.mirrorRef) {
      console.error(`warning: mirror ref "${options.mirrorRef}" was NOT recorded. The existing readonly entity keeps ${result.swarmRef === null ? "no mirror ref" : `mirror ref "${result.swarmRef}"`}`);
    }
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
