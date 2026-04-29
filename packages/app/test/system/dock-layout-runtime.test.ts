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
const FOUR_PANE_FIXTURE_FILES = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];

interface DockLayoutRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
    legacySplitPaneBridgeMatched: boolean;
    splitEditorPaneBridgeMounted: boolean;
  };
  fourPaneScenario: {
    fixtureFiles: string[];
    openedTabTitles: string[];
    openedTabCount: number;
    splitCommandCount: number;
    moveCommandCount: number;
    finalGridPaneCount: number;
    finalGridTabCount: number;
    gridSlots: Array<{
      index: number;
      groupId: string;
      tabCount: number;
      activeTabId: string;
    }>;
    legacyVisualPaneIds: string[];
    operationLog: string[];
  };
  packageImpact: {
    flexlayoutVersion: string;
    dependencyPinned: boolean;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
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
  test("mounts production AppShell EditorGroupsPart path and validates flexlayout provider contract", async () => {
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

    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.errors).toEqual([]);
    expect(result?.productionPath.appShellMounted).toBe(true);
    expect(result?.productionPath.editorGroupsPartMounted).toBe(true);
    expect(result?.productionPath.editorGridProvider).toBe("flexlayout-model");
    expect(result?.productionPath.flexlayoutProviderMatched).toBe(true);
    expect(result?.productionPath.legacySplitPaneBridgeMatched).toBe(false);
    expect(result?.fourPaneScenario.fixtureFiles).toEqual(FOUR_PANE_FIXTURE_FILES);
    expect(result?.fourPaneScenario.openedTabTitles).toEqual(expect.arrayContaining(FOUR_PANE_FIXTURE_FILES));
    expect(result?.fourPaneScenario.openedTabCount).toBe(FOUR_PANE_FIXTURE_FILES.length);
    expect(result?.fourPaneScenario.splitCommandCount).toBe(3);
    expect(result?.fourPaneScenario.moveCommandCount).toBe(1);
    expect(result?.fourPaneScenario.finalGridPaneCount).toBe(4);
    expect(result?.fourPaneScenario.finalGridTabCount).toBe(FOUR_PANE_FIXTURE_FILES.length);
    expect(result?.packageImpact.flexlayoutVersion).toBe("0.9.0");
    expect(result?.packageImpact.dependencyPinned).toBe(true);
    expect(result?.ok).toBe(true);
    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
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

  const parsed = JSON.parse(jsonLine) as Omit<ElectronSmokeOutput, "exitCode">;
  return {
    ...parsed,
    exitCode,
  };
}

function directorySize(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.size;
  }

  return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0);
}
