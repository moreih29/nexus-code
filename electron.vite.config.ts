import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// electron-vite 5.x supports three targets: main, preload, renderer.
// Utility processes (pty-host, lsp-host) run in Electron's utilityProcess
// (Node.js context) so they are bundled as extra entries under the main build.
// See: https://electron-vite.org/guide/build
//
// Native modules (node-pty, better-sqlite3) must not be bundled by Vite.
// They are listed in build.rollupOptions.external so Vite emits require()
// calls that resolve against the installed node_modules at runtime.

const NATIVE_EXTERNALS = ["node-pty", "better-sqlite3"];

// ---------------------------------------------------------------------------
// Vite plugin: emit src/renderer/styles/theme.generated.css at build start.
// Only registered in the renderer config so it never runs in main/preload.
//
// Single source of truth for the generator lives in
// scripts/generate-theme-css.ts. Both `bun run scripts/generate-theme-css.ts`
// and the dev/build pipeline call the same function so output is identical.
// ---------------------------------------------------------------------------
function themeTokensPlugin(): Plugin {
  return {
    name: "vite-plugin-theme-tokens",
    buildStart() {
      // Dynamic require to avoid caching issues — re-evaluate each build.
      const { generateThemeCss } =
        require("./scripts/generate-theme-css") as typeof import("./scripts/generate-theme-css");

      const outPath = resolve(__dirname, "src/renderer/styles/theme.generated.css");
      writeFileSync(outPath, generateThemeCss(), "utf-8");
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "pty-host": resolve(__dirname, "src/utility/pty-host/index.ts"),
          "lsp-host": resolve(__dirname, "src/utility/lsp-host/index.ts"),
        },
        external: NATIVE_EXTERNALS,
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
        external: NATIVE_EXTERNALS,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [themeTokensPlugin(), tailwindcss(), react()],
  },
});
