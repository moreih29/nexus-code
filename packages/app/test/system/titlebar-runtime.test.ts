import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/titlebar-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusTitlebarRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

interface TitlebarDomProbe {
  mounted: boolean;
  platform: string | null;
  role: string | null;
  ariaLabel: string | null;
  computedHeight: string;
  inlineHeight: string;
  paddingLeft: string;
  appRegion: string;
  appRegionMatched: boolean;
  triggerAppRegion: string;
  triggerNoDragRegionMatched: boolean;
  triggerAriaLabel: string | null;
  triggerShortcut: string | null;
  triggerText: string;
  shortcutVisible: boolean;
  styleAttribute: string | null;
  triggerStyleAttribute: string | null;
}

interface TitlebarRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  activeTitlebar: TitlebarDomProbe;
  fallbackTitlebar: TitlebarDomProbe;
  interaction: {
    openWorkspaceCalls: number;
    unexpectedPaletteCallsFromFallback: number;
    unexpectedWorkspaceCallsFromPalette: number;
  };
  palette: {
    openBeforeClick: boolean;
    openAfterFallbackClick: boolean;
    openAfterPaletteClick: boolean;
    inputMountedAfterPaletteClick: boolean;
    inputPlaceholder: string | null;
    commandItemTexts: string[];
  };
  fullscreen: {
    attempted: boolean;
    nativeTrafficLightCoordinatesObservable: boolean;
    limitation: string;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: TitlebarRuntimeSmokeResult;
  suspiciousMessages: string[];
  logs: Array<{
    level: number;
    message: string;
    lineNumber: number;
    sourceId: string;
  }>;
}

const electronBinary = resolveElectronBinary();

let viteServer: ViteDevServer | null = null;

afterEach(async () => {
  await viteServer?.close();
  viteServer = null;
});

describe("titlebar runtime system smoke", () => {
  test("mounts titlebars with drag tokens and opens the command palette from the workspace trigger", async () => {
    viteServer = await createServer({
      configFile: false,
      root: APP_ROOT,
      logLevel: "error",
      resolve: {
        alias: {
          "@": resolve(APP_ROOT, "src/renderer"),
        },
      },
      plugins: [react()],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await viteServer.listen();

    const baseUrl = viteServer.resolvedUrls?.local[0];
    expect(baseUrl).toBeDefined();
    const smokeUrl = new URL(SMOKE_HTML_PATH, baseUrl).href;
    const output = await runElectronSmoke(smokeUrl);
    const result = output.rendererResult;

    expect(output.status).toBe("ok");
    expect(output.suspiciousMessages).toEqual([]);
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);

    expect(result?.activeTitlebar.mounted).toBe(true);
    expect(result?.activeTitlebar.platform).toBe("darwin");
    expect(result?.activeTitlebar.role).toBe("banner");
    expect(result?.activeTitlebar.ariaLabel).toBe("Application titlebar");
    expect(result?.activeTitlebar.computedHeight).toBe("36px");
    expect(result?.activeTitlebar.inlineHeight).toBe("36px");
    expect(result?.activeTitlebar.paddingLeft).toBe("78px");
    expect(result?.activeTitlebar.appRegionMatched).toBe(true);
    expect(result?.activeTitlebar.triggerNoDragRegionMatched).toBe(true);
    expect(result?.activeTitlebar.triggerText).toBe("Search commands⌘P");
    expect(result?.activeTitlebar.shortcutVisible).toBe(true);

    expect(result?.fallbackTitlebar.mounted).toBe(true);
    expect(result?.fallbackTitlebar.platform).toBe("win32");
    expect(result?.fallbackTitlebar.computedHeight).toBe("36px");
    expect(result?.fallbackTitlebar.paddingLeft).toBe("0px");
    expect(result?.fallbackTitlebar.appRegionMatched).toBe(true);
    expect(result?.fallbackTitlebar.triggerNoDragRegionMatched).toBe(true);
    expect(result?.fallbackTitlebar.triggerText).toBe("Open workspace…");
    expect(result?.fallbackTitlebar.shortcutVisible).toBe(false);

    expect(result?.interaction.openWorkspaceCalls).toBe(1);
    expect(result?.interaction.unexpectedPaletteCallsFromFallback).toBe(0);
    expect(result?.interaction.unexpectedWorkspaceCallsFromPalette).toBe(0);
    expect(result?.palette.openBeforeClick).toBe(false);
    expect(result?.palette.openAfterFallbackClick).toBe(false);
    expect(result?.palette.openAfterPaletteClick).toBe(true);
    expect(result?.palette.inputMountedAfterPaletteClick).toBe(true);
    expect(result?.palette.inputPlaceholder).toBe("Type a command...");
    expect(result?.palette.commandItemTexts.some((text) => text.includes("Titlebar Fixture Command"))).toBe(true);

    expect(result?.fullscreen.attempted).toBe(false);
    expect(result?.fullscreen.nativeTrafficLightCoordinatesObservable).toBe(false);
    expect(result?.fullscreen.limitation).toContain("traffic-light coordinates are not observable");
  }, SMOKE_TIMEOUT_MS + 10_000);
});

async function runElectronSmoke(smokeUrl: string): Promise<ElectronSmokeOutput> {
  const child = spawn(String(electronBinary), [RUNNER_PATH, smokeUrl, String(SMOKE_TIMEOUT_MS), RESULT_GLOBAL_NAME], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Electron smoke timed out after ${SMOKE_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, SMOKE_TIMEOUT_MS + 5_000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });

  const jsonLine = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  if (!jsonLine) {
    throw new Error(`Electron smoke produced no JSON output. exit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const parsed = JSON.parse(jsonLine) as ElectronSmokeOutput;
  if (exitCode !== 0) {
    throw new Error(
      `Electron smoke failed with status ${parsed.status}.\n` +
        `rendererResult=${JSON.stringify(parsed.rendererResult, null, 2)}\n` +
        `suspiciousMessages=${JSON.stringify(parsed.suspiciousMessages, null, 2)}\n` +
        `logs=${JSON.stringify(parsed.logs, null, 2)}\n` +
        `stderr=${stderr}`,
    );
  }

  return parsed;
}
