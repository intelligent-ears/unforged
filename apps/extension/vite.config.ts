import { resolve } from "node:path";
import { defineConfig } from "vite";

// background.ts and the HTML pages are separate entries; public/manifest.json is copied as-is.
// UNFORGED_FIXTURE=1 bundles the demo snapshot as a fallback until the first sync; the default
// build leaves it out entirely (scripts/check-no-fixture.mjs checks that).
export default defineConfig({
  root: "src",
  define: { __UNFORGED_FIXTURE__: JSON.stringify(process.env.UNFORGED_FIXTURE === "1") },
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        popup: resolve(import.meta.dirname, "src/popup.html"),
        blocked: resolve(import.meta.dirname, "src/blocked.html"),
        options: resolve(import.meta.dirname, "src/options.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
