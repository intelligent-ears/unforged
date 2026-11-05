import { readFileSync } from "node:fs";
import type { Manifest } from "@unforged/core";
import { z } from "zod";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";

const manifestSchema = z.strictObject({
  version: z.literal(1),
  dapp: z.string(),
  release: z.string(),
  commit: z.string(),
  files: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()),
});

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError(EXIT_BAD_INPUT, `can't read ${path}`);
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT_BAD_INPUT, `${path} is not valid JSON`);
  }
}

export function readManifest(path: string): Manifest {
  const result = manifestSchema.safeParse(readJson(path));
  if (!result.success) throw new CliError(EXIT_BAD_INPUT, `${path} is not a manifest:\n${z.prettifyError(result.error)}`);
  return result.data as Manifest;
}
