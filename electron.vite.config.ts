import {
  cpSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import svgr from "vite-plugin-svgr";

const NATIVE_EXTERNALS = ["node-pty", "better-sqlite3", "onnxruntime-node"];

const NEXUS_CHANNEL = process.env.NEXUS_CHANNEL === "beta" ? "beta" : "stable";
const NEXUS_REMOTE_AGENT_ROOT = NEXUS_CHANNEL === "beta" ? "~/.nexus-code-beta" : "~/.nexus-code";
const NEXUS_REMOTE_AGENT_MANIFEST = `${NEXUS_REMOTE_AGENT_ROOT}/manifest.json`;

const CHANNEL_DEFINES = {
  __NEXUS_REMOTE_AGENT_ROOT__: JSON.stringify(NEXUS_REMOTE_AGENT_ROOT),
  __NEXUS_REMOTE_AGENT_MANIFEST__: JSON.stringify(NEXUS_REMOTE_AGENT_MANIFEST),
  __NEXUS_CHANNEL__: JSON.stringify(NEXUS_CHANNEL),
};

const APP_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version: string }
).version;

const RENDERER_DEFINES = {
  __APP_VERSION__: JSON.stringify(APP_VERSION),
};

const DEV_SERVER_PORT = process.env.NEXUS_DEV_PORT
  ? Number(process.env.NEXUS_DEV_PORT)
  : 41000 + Math.floor(Math.random() * 8000);

function themeTokensPlugin(): Plugin {
  return {
    name: "vite-plugin-theme-tokens",
    buildStart() {
      const { generateThemeCss } =
        require("./scripts/generate-theme-css") as typeof import("./scripts/generate-theme-css");

      const outPath = resolve(__dirname, "src/renderer/styles/theme.generated.css");
      writeFileSync(outPath, generateThemeCss(), "utf-8");
    },
  };
}

const MONACO_VS_DIR = "monaco/vs";

const MONACO_MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ttf": "font/ttf",
};

function monacoAssetsPlugin(): Plugin {
  const packageJson = createRequire(resolve(__dirname, "package.json")).resolve(
    "monaco-editor/package.json",
  );
  const source = resolve(dirname(packageJson), "min/vs");
  return {
    name: "vite-plugin-monaco-assets",
    configureServer(server) {
      server.middlewares.use(`/${MONACO_VS_DIR}`, (req, res, next) => {
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        const file = resolve(source, `.${pathname}`);
        if (!file.startsWith(`${source}${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          MONACO_MIME_TYPES[extname(file)] ?? "application/octet-stream",
        );
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      cpSync(source, resolve(options.dir, MONACO_VS_DIR), { recursive: true });
    },
  };
}

const EXCALIDRAW_FONTS_DIR = "excalidraw/fonts";

function excalidrawRoot(): string {
  const entry = createRequire(resolve(__dirname, "package.json")).resolve("@excalidraw/excalidraw");
  const marker = `${sep}@excalidraw${sep}excalidraw${sep}`;
  return entry.slice(0, entry.lastIndexOf(marker) + marker.length);
}

function excalidrawAssetsPlugin(): Plugin {
  const source = resolve(excalidrawRoot(), "dist/prod/fonts");
  const types: Record<string, string> = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
  };
  return {
    name: "vite-plugin-excalidraw-assets",
    configureServer(server) {
      server.middlewares.use(`/${EXCALIDRAW_FONTS_DIR}`, (req, res, next) => {
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        const file = resolve(source, `.${pathname}`);
        if (!file.startsWith(`${source}${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      if (!existsSync(source)) {
        this.warn(`Excalidraw's fonts are not at ${source}: sketches fall back to its CDN`);
        return;
      }
      cpSync(source, resolve(options.dir, EXCALIDRAW_FONTS_DIR), { recursive: true });
    },
  };
}

const EXCALIDRAW_SHARED_CHUNK = "excalidraw-shared";

function staticImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file) || !existsSync(file)) return seen;
  seen.add(file);
  for (const match of readFileSync(file, "utf8").matchAll(
    /\b(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g,
  )) {
    staticImports(resolve(dirname(file), match[1] ?? ""), seen);
  }
  return seen;
}

function modulePath(id: string): string {
  const path = id.split("?")[0]?.replace(/\\/g, "/") ?? "";
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function excalidrawManualChunks(): (id: string) => string | undefined {
  const dist = resolve(excalidrawRoot(), "dist/prod");
  const worker = staticImports(resolve(dist, "subset-worker.chunk.js"));
  const entry = staticImports(resolve(dist, "index.js"));
  const shared = new Set([...worker].filter((file) => entry.has(file)).map(modulePath));
  return (id) => (shared.has(modulePath(id)) ? EXCALIDRAW_SHARED_CHUNK : undefined);
}

const AMD_CHECK = /\bdefine\.amd\b(?!\s*=(?!=))/g;

function withoutAmdCheck(code: string): string | null {
  if (!code.includes("define.amd")) return null;
  const out = code.replace(AMD_CHECK, "false");
  return out === code ? null : out;
}

function noAmdPlugin(): Plugin {
  return {
    name: "vite-plugin-no-amd",
    config: () => ({
      optimizeDeps: {
        esbuildOptions: {
          plugins: [
            {
              name: "no-amd",
              setup(build) {
                build.onLoad({ filter: /[\\/]node_modules[\\/].*\.c?js$/ }, (args) => {
                  const contents = withoutAmdCheck(readFileSync(args.path, "utf8"));
                  return contents === null ? undefined : { contents, loader: "js" };
                });
              },
            },
          ],
        },
      },
    }),
    transform(code, id) {
      if (!id.includes("/node_modules/")) return null;
      const out = withoutAmdCheck(code);
      return out === null ? null : { code: out, map: null };
    },
  };
}

function gitEditorHelperPlugin(): Plugin {
  const source = resolve(__dirname, "src/main/features/git/domain/helpers/editor-helper.cjs");
  return {
    name: "vite-plugin-git-editor-helper",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "git/editor-helper.cjs",
        source: readFileSync(source, "utf8"),
      });
    },
  };
}

export default defineConfig({
  main: {
    define: CHANNEL_DEFINES,
    plugins: [gitEditorHelperPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "state-writer": resolve(__dirname, "src/main/infra/storage/state-writer.worker.ts"),
          "voice-print-host": resolve(__dirname, "src/main/features/voice-print/host.ts"),
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
    define: RENDERER_DEFINES,
    server: {
      port: DEV_SERVER_PORT,
      strictPort: false,
    },
    build: {
      assetsInlineLimit: (filePath: string) =>
        filePath.includes("assets/icons/material/") || filePath.endsWith(".worklet.js")
          ? false
          : undefined,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
        output: {
          manualChunks: excalidrawManualChunks(),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [
      themeTokensPlugin(),
      monacoAssetsPlugin(),
      excalidrawAssetsPlugin(),
      noAmdPlugin(),
      tailwindcss(),
      react(),
      svgr(),
    ],
  },
});
