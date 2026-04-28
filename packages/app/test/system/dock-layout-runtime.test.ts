import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/dock-layout-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusDockLayoutRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

interface DockLayoutRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  initialPaneIds: string[];
  expandedPaneIds: string[];
  initialPaneCount: number;
  expandedPaneCount: number;
  layoutStatePaneCount: number;
  dropDirections: string[];
  splitterSymmetry: Array<{
    orientation: "horizontal" | "vertical";
    growBeforeWeights: number[];
    growAfterWeights: number[];
    mirrored: boolean;
  }>;
  floating: {
    actionType: string;
    requestedType: string;
    subLayoutTypes: string[];
    floatingLayoutCreated: boolean;
  };
  cssBridge: {
    hostClassApplied: boolean;
    appPrimaryVar: string;
    bridgePrimaryVar: string;
    layoutDragColor: string;
    tabsetDividerColor: string;
    paneBackground: string;
    paneBorderColor: string;
    primaryLooksOklch: boolean;
    bridgePrimaryMatchesApp: boolean;
    dragColorApplied: boolean;
    dividerColorApplied: boolean;
    panelBackgroundApplied: boolean;
    panelBorderApplied: boolean;
  };
  strictMode: {
    iterations: number;
    leakSignals: string[];
    leakSignalCount: number;
  };
  deliberateFailSignature: {
    missingPaneDetected: boolean;
    fourPaneCount: number;
    expectedPaneCount: number;
  };
  packageImpact: {
    flexlayoutVersion: string;
    dependencyPinned: boolean;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: DockLayoutRuntimeSmokeResult;
  suspiciousMessages: string[];
  logs: Array<{
    level: number;
    message: string;
    lineNumber: number;
    sourceId: string;
  }>;
}

let viteServer: ViteDevServer | null = null;

afterEach(async () => {
  await viteServer?.close();
  viteServer = null;
});

describe("dock layout runtime system smoke", () => {
  test("renders flexlayout adoption fixture through Electron renderer and validates dock criteria", async () => {
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
    expect(result?.initialPaneCount).toBe(4);
    expect(result?.expandedPaneCount).toBe(6);
    expect(result?.layoutStatePaneCount).toBe(6);
    expect(result?.initialPaneIds).toEqual(expect.arrayContaining(["pane-1-tab", "pane-2-tab", "pane-3-tab", "pane-4-tab"]));
    expect(result?.expandedPaneIds).toEqual(
      expect.arrayContaining(["pane-1-tab", "pane-2-tab", "pane-3-tab", "pane-4-tab", "pane-5-tab", "pane-6-tab"]),
    );
    expect(result?.dropDirections.sort()).toEqual(["bottom", "center", "left", "right", "top"]);
    expect(result?.splitterSymmetry.every((probe) => probe.mirrored)).toBe(true);
    expect(result?.splitterSymmetry.map((probe) => probe.growBeforeWeights)).toEqual([
      [60, 40],
      [60, 40],
    ]);
    expect(result?.splitterSymmetry.map((probe) => probe.growAfterWeights)).toEqual([
      [40, 60],
      [40, 60],
    ]);
    expect(result?.floating.floatingLayoutCreated).toBe(true);
    expect(result?.floating.subLayoutTypes).toContain("float");
    expect(result?.cssBridge.hostClassApplied).toBe(true);
    expect(result?.cssBridge.primaryLooksOklch).toBe(true);
    expect(result?.cssBridge.bridgePrimaryMatchesApp).toBe(true);
    expect(result?.cssBridge.dragColorApplied).toBe(true);
    expect(result?.cssBridge.dividerColorApplied).toBe(true);
    expect(result?.cssBridge.panelBackgroundApplied).toBe(true);
    expect(result?.cssBridge.panelBorderApplied).toBe(true);
    expect(result?.strictMode.iterations).toBe(5);
    expect(result?.strictMode.leakSignalCount).toBe(0);
    expect(result?.strictMode.leakSignals).toEqual([]);
    expect(result?.deliberateFailSignature.missingPaneDetected).toBe(true);
    expect(result?.packageImpact.flexlayoutVersion).toBe("0.9.0");
    expect(result?.packageImpact.dependencyPinned).toBe(true);
  }, SMOKE_TIMEOUT_MS + 10_000);

  test("reports current flexlayout package footprint for bundle/build impact tracking", () => {
    const packageJson = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8"));
    const packageSizeBytes = directorySize(resolve(APP_ROOT, "node_modules/flexlayout-react"));
    const packageMeta = JSON.parse(readFileSync(resolve(APP_ROOT, "node_modules/flexlayout-react/package.json"), "utf8"));

    expect(packageJson.dependencies["flexlayout-react"]).toBe("0.9.0");
    expect(packageMeta.version).toBe("0.9.0");
    expect(packageSizeBytes).toBeGreaterThan(0);

    console.info(
      JSON.stringify({
        flexlayoutRuntimeImpact: {
          dependency: "flexlayout-react@0.9.0",
          installedPackageSizeBytes: packageSizeBytes,
        },
      }),
    );
  });
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

function directorySize(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.size;
  }

  return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0);
}
