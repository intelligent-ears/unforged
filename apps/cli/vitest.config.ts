import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests run against the workspace packages' source, so they don't need them built first.
export default defineConfig({
  resolve: {
    alias: {
      "@unforged/core": source("../../packages/core/src/index.ts"),
      "@unforged/registry": source("../../packages/registry/src/index.ts"),
    },
  },
});
