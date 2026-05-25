import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// electron-vite 5.x supports three targets: main, preload, renderer.
// See: https://electron-vite.org/guide/build
//
// Native modules (node-pty, better-sqlite3) must not be bundled by Vite.
// They are listed in build.rollupOptions.external so Vite emits require()
// calls that resolve against the installed node_modules at runtime.

const NATIVE_EXTERNALS = ["node-pty", "better-sqlite3"];

// ---------------------------------------------------------------------------
// Channel-aware build-time constants.
//
// `NEXUS_CHANNEL` env (stable | beta) selects which remote SSH agent root the
// packaged app installs to. Two channels live in parallel sibling directories
// on the remote host so a stable and a beta build can share a remote without
// clobbering each other.
//
// Consumed by `src/main/infra/agent/ssh/ssh-bootstrap/types.ts` via
// `declare const __NEXUS_REMOTE_AGENT_ROOT__` ambient declaration (in
// `src/main/types/build-define.d.ts`). The `types.ts` constants additionally
// honor `process.env.NEXUS_REMOTE_AGENT_ROOT` / `NEXUS_REMOTE_AGENT_MANIFEST`
// as an escape hatch for debugging.
// ---------------------------------------------------------------------------
const NEXUS_CHANNEL = process.env.NEXUS_CHANNEL === "beta" ? "beta" : "stable";
const NEXUS_REMOTE_AGENT_ROOT =
  NEXUS_CHANNEL === "beta" ? "~/.nexus-code-beta" : "~/.nexus-code";
const NEXUS_REMOTE_AGENT_MANIFEST = `${NEXUS_REMOTE_AGENT_ROOT}/manifest.json`;

const CHANNEL_DEFINES = {
  __NEXUS_REMOTE_AGENT_ROOT__: JSON.stringify(NEXUS_REMOTE_AGENT_ROOT),
  __NEXUS_REMOTE_AGENT_MANIFEST__: JSON.stringify(NEXUS_REMOTE_AGENT_MANIFEST),
  __NEXUS_CHANNEL__: JSON.stringify(NEXUS_CHANNEL),
};

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
    define: CHANNEL_DEFINES,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
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
