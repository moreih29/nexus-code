import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// electron-vite 5.x supports three targets: main, preload, renderer.
// Utility processes (pty-host, lsp-host) run in Electron's utilityProcess
// (Node.js context) so they are bundled as extra entries under the main build.
// See: https://electron-vite.org/guide/build
//
// Native modules (node-pty, better-sqlite3) must not be bundled by Vite.
// They are listed in build.rollupOptions.external so Vite emits require()
// calls that resolve against the installed node_modules at runtime.

const NATIVE_EXTERNALS = ["node-pty", "better-sqlite3"];

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
    plugins: [react()],
  },
});
