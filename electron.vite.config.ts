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
const NEXUS_REMOTE_AGENT_ROOT = NEXUS_CHANNEL === "beta" ? "~/.nexus-code-beta" : "~/.nexus-code";
const NEXUS_REMOTE_AGENT_MANIFEST = `${NEXUS_REMOTE_AGENT_ROOT}/manifest.json`;

const CHANNEL_DEFINES = {
  __NEXUS_REMOTE_AGENT_ROOT__: JSON.stringify(NEXUS_REMOTE_AGENT_ROOT),
  __NEXUS_REMOTE_AGENT_MANIFEST__: JSON.stringify(NEXUS_REMOTE_AGENT_MANIFEST),
  __NEXUS_CHANNEL__: JSON.stringify(NEXUS_CHANNEL),
};

// ---------------------------------------------------------------------------
// App version build-time constant for renderer surfaces (e.g. About panel).
//
// Renderer cannot call `app.getVersion()` directly, so we read the version
// from package.json at config-evaluation time and inject it via Vite define.
// Consumed through the `__APP_VERSION__` ambient declaration in
// `src/renderer/types/build-define.d.ts`.
// ---------------------------------------------------------------------------
const APP_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version: string }
).version;

const RENDERER_DEFINES = {
  __APP_VERSION__: JSON.stringify(APP_VERSION),
};

// ---------------------------------------------------------------------------
// Dev 서버 포트.
//
// 기본 5173은 다른 프로젝트의 dev 서버와 자주 충돌한다. 이 Electron 앱의 dev
// 서버 URL은 사용자가 직접 입력할 일이 없고(main이 ELECTRON_RENDERER_URL로
// 자동 로드) 포트 값 자체는 무의미하므로, 매 실행마다 빈 포트 하나를 동적으로
// 잡는다.
//
// - 범위 41000–48999: 흔한 개발 포트(3000/4200/5000/5173/8000/8080/9000/6006
//   등)를 피하고, macOS ephemeral 대역(49152~) 미만이라 OS 자동할당과도
//   겹치지 않는다.
// - strictPort:false: 무작위로 고른 포트가 드물게 점유돼 있어도 Vite가 다음
//   빈 포트로 증가시키며, 그 실제 포트를 config.server.port / resolvedUrls에
//   반영한다. electron-vite는 이 값으로 ELECTRON_RENDERER_URL을 구성하므로
//   main 창은 항상 올바른 포트를 로드한다.
//
// 고정 포트가 필요하면 NEXUS_DEV_PORT 환경변수로 덮어쓸 수 있다.
const DEV_SERVER_PORT = process.env.NEXUS_DEV_PORT
  ? Number(process.env.NEXUS_DEV_PORT)
  : 41000 + Math.floor(Math.random() * 8000);

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

// ---------------------------------------------------------------------------
// Vite plugin: ship monaco-editor's AMD build with the app.
//
// @monaco-editor/react loads Monaco at runtime from `<paths.vs>/loader.js`,
// by default on the jsDelivr CDN — so without network the editor never
// loads. This copies the installed package's `min/vs` (the same build the CDN
// serves) next to the renderer as `monaco/vs`, served by the dev server and
// written into the build, and src/renderer/services/editor/runtime/
// monaco-loader.ts points the loader there.
// ---------------------------------------------------------------------------
const MONACO_VS_DIR = "monaco/vs";

const MONACO_MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ttf": "font/ttf",
};

function monacoAssetsPlugin(): Plugin {
  // The config is bundled as ESM, where `require` is a shim without resolve().
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

// ---------------------------------------------------------------------------
// Vite plugin: ship Excalidraw's fonts with the renderer.
//
// The sketch blocks of notes draw with Excalidraw, which loads its fonts
// from window.EXCALIDRAW_ASSET_PATH (set in notes/editor/excalidraw-assets.ts)
// and from a CDN when that is not set. They are served from here in dev and
// copied next to the renderer's index.html in a build, so a sketch draws
// offline and the app asks no one else for them.
// ---------------------------------------------------------------------------
const EXCALIDRAW_FONTS_DIR = "excalidraw/fonts";

function excalidrawAssetsPlugin(): Plugin {
  // The package exports no ./package.json: its root is found from its entry.
  const entry = createRequire(resolve(__dirname, "package.json")).resolve("@excalidraw/excalidraw");
  const marker = `${sep}@excalidraw${sep}excalidraw${sep}`;
  const root = entry.slice(0, entry.lastIndexOf(marker) + marker.length);
  const source = resolve(root, "dist/prod/fonts");
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

// ---------------------------------------------------------------------------
// Vite plugin: keep UMD dependencies off Monaco's AMD loader.
//
// The editor's loader (@monaco-editor/react, AMD build) leaves a global
// `define` with `define.amd` set. A UMD module bundled into the renderer (as
// Excalidraw's es6-promise-pool is) that runs after it registers itself with
// that loader instead of filling `module.exports`, and what imports it gets an
// empty object ("import_es6_promise_pool.default is not a constructor"). The
// dependencies' AMD check is turned off, in the dev server's pre-bundling and
// in a build alike; an assignment to `define.amd` (a loader's own) is kept.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Vite plugin: ship the git editor helper with the main process.
//
// Git starts the helper as a script of its own (the app run as node), so
// nothing imports it and the bundle leaves it out. This writes it where the
// bundled main process looks for it (resolveDefaultHelperDir in
// src/main/features/git/domain/helpers/launcher.ts): git/ next to index.js.
// ---------------------------------------------------------------------------
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
      // Material file-icon SVGs are URL-referenced (`?url`) and rendered via
      // <img>. Never inline them as base64 — ~1000 icons would bloat the main
      // bundle and every user (including the default Minimal theme, which never
      // shows them) would pay for it. Emitting them as separate files preserves
      // on-demand, browser-cached loading (VS Code-style) and keeps startup lean.
      // All other assets keep Vite's default inline threshold.
      assetsInlineLimit: (filePath: string) =>
        filePath.includes("assets/icons/material/") ? false : undefined,
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
