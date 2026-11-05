// Exit codes from docs/cli-registry.md, plus the conventional 1 for input the CLI refuses.
export const EXIT_BAD_INPUT = 1;
export const EXIT_BUILD_FAILED = 2;
export const EXIT_NONDETERMINISM = 3;
export const EXIT_MIRROR_MISMATCH = 3;
export const EXIT_REGISTRY = 4;

/** A failure the user should see as one message and an exit code, without a stack trace. */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}
