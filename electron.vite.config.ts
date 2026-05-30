import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
const NEXUS_REMOTE_AGENT_ROOT =
  NEXUS_CHANNEL === "beta" ? "~/.nexus-code-beta" : "~/.nexus-code";
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
    define: RENDERER_DEFINES,
    server: {
      port: DEV_SERVER_PORT,
      strictPort: false,
    },
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
    plugins: [themeTokensPlugin(), tailwindcss(), react(), svgr()],
  },
});
