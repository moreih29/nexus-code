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
// ---------------------------------------------------------------------------
function themeTokensPlugin(): Plugin {
  return {
    name: "vite-plugin-theme-tokens",
    buildStart() {
      // Dynamic import to avoid caching issues — re-evaluate each build.
      // Use require-style sync import via bun/node module resolution.
      const { borderRadius, buildSemanticTokens, color, fontFamily, spacing, typeScale } =
        require("./src/shared/design-tokens") as typeof import("./src/shared/design-tokens");

      function camelToKebab(s: string): string {
        return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
      }

      const lines: string[] = [];

      lines.push("@theme {");
      for (const [key, value] of Object.entries(color)) {
        lines.push(`  --color-${camelToKebab(key)}: ${value};`);
      }
      const TAILWIND_FONT_KEYS = new Set(["sans", "mono"]);
      for (const [key, value] of Object.entries(fontFamily)) {
        const varName = TAILWIND_FONT_KEYS.has(key)
          ? `--font-${camelToKebab(key)}`
          : `--font-family-${camelToKebab(key)}`;
        lines.push(`  ${varName}: ${value};`);
      }
      for (const [role, def] of Object.entries(typeScale)) {
        const kebab = camelToKebab(role);
        lines.push(`  --type-${kebab}-size: ${def.fontSize}px;`);
        lines.push(`  --type-${kebab}-line-height: ${def.lineHeight};`);
        lines.push(`  --type-${kebab}-letter-spacing: ${def.letterSpacing}px;`);
      }
      for (const value of spacing) {
        lines.push(`  --space-${value}: ${value}px;`);
      }
      for (const [key, value] of Object.entries(borderRadius)) {
        lines.push(`  --radius-${camelToKebab(key)}: ${value}px;`);
      }
      lines.push("}");
      lines.push("");

      lines.push(":root {");
      const semantic = buildSemanticTokens();
      for (const [key, value] of Object.entries(semantic)) {
        lines.push(`  ${key}: ${value};`);
      }
      lines.push("}");
      lines.push("");

      const outPath = resolve(__dirname, "src/renderer/styles/theme.generated.css");
      writeFileSync(outPath, lines.join("\n"), "utf-8");
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
