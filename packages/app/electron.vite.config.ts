import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const RENDERER_NODE_PTY_BLOCK_ALIAS = "virtual:nexus-renderer-node-pty-blocked";
export const RENDERER_NODE_PTY_BLOCK_MESSAGE =
  "Renderer must not import node-pty. Route PTY access through preload/main IPC.";

export function rendererNodePtyImportGuardPlugin(): Plugin {
  return {
    name: "nexus-renderer-node-pty-import-guard",
    enforce: "pre",
    resolveId(source) {
      if (source === RENDERER_NODE_PTY_BLOCK_ALIAS) {
        return RENDERER_NODE_PTY_BLOCK_ALIAS;
      }

      if (source === "node-pty" || source.startsWith("node-pty/")) {
        return RENDERER_NODE_PTY_BLOCK_ALIAS;
      }

      return null;
    },
    load(id) {
      if (id === RENDERER_NODE_PTY_BLOCK_ALIAS) {
        throw new Error(RENDERER_NODE_PTY_BLOCK_MESSAGE);
      }

      return null;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: path.resolve(APP_ROOT, "src/main/entry.ts"),
        },
        external: ["node-pty"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: path.resolve(APP_ROOT, "src/preload/index.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          chunkFileNames: "chunks/[name]-[hash].cjs",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  },
  renderer: {
    root: path.resolve(APP_ROOT, "src/renderer"),
    resolve: {
      alias: [
        {
          find: "@",
          replacement: path.resolve(APP_ROOT, "src/renderer"),
        },
        {
          find: /^node-pty$/,
          replacement: RENDERER_NODE_PTY_BLOCK_ALIAS,
        },
      ],
    },
    plugins: [react(), rendererNodePtyImportGuardPlugin()],
    build: {
      outDir: path.resolve(APP_ROOT, "out/renderer"),
      emptyOutDir: true,
    },
  },
});
