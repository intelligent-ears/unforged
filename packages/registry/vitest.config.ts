import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against core's source, so they don't need core to be built first.
export default defineConfig({
  resolve: {
    alias: { "@unforged/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) },
  },
});
