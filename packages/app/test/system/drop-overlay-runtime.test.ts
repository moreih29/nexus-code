import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const ENTRY_PATH = resolve(import.meta.dir, "drop-overlay-runtime.entry.tsx");
const FIXTURE_HTML_PATH = resolve(import.meta.dir, "drop-overlay-runtime.fixture.html");
const SMOKE_HTML_PATH = "/test/system/drop-overlay-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusDropOverlayRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const DROP_ZONES = ["top", "right", "bottom", "left", "center"] as const;
const HOVER_BUDGET_MS = 200;

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface DropOverlayZoneProbe {
  zone: typeof DROP_ZONES[number];
  matched: boolean;
  visibleWithinMs: number;
  activeGroupRect: RectSnapshot;
  expectedIndicatorRect: RectSnapshot;
  actualIndicatorRect: RectSnapshot;
  deltaPx: RectSnapshot;
  indicatorClassName: string;
  borderColor: string;
  backgroundColor: string;
  indicatorCountAfterDragEnd: number;
  reason?: string;
}

interface DropOverlayRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  fourPaneScenario: {
    fixtureFiles: string[];
    openedTabTitles: string[];
    finalGridPaneCount: number;
    finalGridTabCount: number;
    activeGroupId: string;
    sourceTabTitle: string;
    targetTabTitle: string;
  };
  overlay: {
    hoverBudgetMs: number;
    tolerancePx: number;
    zones: DropOverlayZoneProbe[];
    finalIndicatorCount: number;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: DropOverlayRuntimeSmokeResult;
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

describe("drop overlay runtime system smoke", () => {
  test("validates flexlayout top/right/bottom/left/center drop indicators against the active group rect", async () => {
    expect(existsSync(ENTRY_PATH)).toBe(true);
    expect(existsSync(FIXTURE_HTML_PATH)).toBe(true);

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
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.productionPath.appShellMounted).toBe(true);
    expect(result?.productionPath.editorGroupsPartMounted).toBe(true);
    expect(result?.productionPath.editorGridProvider).toBe("flexlayout-model");
    expect(result?.productionPath.flexlayoutProviderMatched).toBe(true);
    expect(result?.fourPaneScenario.finalGridPaneCount).toBe(4);
    expect(result?.fourPaneScenario.finalGridTabCount).toBe(4);
    expect(result?.overlay.hoverBudgetMs).toBe(HOVER_BUDGET_MS);
    expect(result?.overlay.zones.map((zone) => zone.zone)).toEqual([...DROP_ZONES]);
    expect(result?.overlay.zones.every((zone) => zone.matched)).toBe(true);
    expect(result?.overlay.zones.every((zone) => zone.visibleWithinMs <= HOVER_BUDGET_MS)).toBe(true);
    expect(result?.overlay.zones.every((zone) => zone.indicatorCountAfterDragEnd === 0)).toBe(true);
    expect(result?.overlay.finalIndicatorCount).toBe(0);
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

  const parsed = JSON.parse(jsonLine) as Omit<ElectronSmokeOutput, "exitCode">;
  const output: ElectronSmokeOutput = {
    ...parsed,
    exitCode,
  };

  if (exitCode !== 0) {
    throw new Error(
      `Electron smoke failed with status ${output.status}.\n` +
        `rendererResult=${JSON.stringify(output.rendererResult, null, 2)}\n` +
        `suspiciousMessages=${JSON.stringify(output.suspiciousMessages, null, 2)}\n` +
        `logs=${JSON.stringify(output.logs, null, 2)}\n` +
        `stderr=${stderr}`,
    );
  }

  return output;
}
