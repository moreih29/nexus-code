import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const ENTRY_PATH = resolve(import.meta.dir, "editor-split-fill-runtime.entry.tsx");
const FIXTURE_HTML_PATH = resolve(import.meta.dir, "editor-split-fill-runtime.fixture.html");
const SMOKE_HTML_PATH = "/test/system/editor-split-fill-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorSplitFillRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 15_000;
const SCENARIOS = ["horizontal", "vertical", "four-pane", "six-pane"] as const;

interface SplitFillScenarioResult {
  id: typeof SCENARIOS[number];
  status: string;
  expectedGroupCount: number;
  actualGroupCount: number;
  groups: Array<{ groupId: string; rect: { width: number; height: number }; nonzero: boolean; contained: boolean }>;
  allGroupsNonzero: boolean;
  allGroupsContained: boolean;
  layoutFillsScenario: boolean;
  areaCoverageRatio: number;
  fillConsistent: boolean;
  axisConsistency: { checked: string; passed: boolean; reason?: string };
  reason?: string;
}

interface EditorSplitFillRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: Record<typeof SCENARIOS[number], SplitFillScenarioResult>;
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorSplitFillRuntimeSmokeResult;
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

describe("editor split fill runtime system smoke", () => {
  test("keeps horizontal, vertical, four-pane, and six-pane editor groups nonzero and filling their containers", async () => {
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

    console.info(JSON.stringify({
      editorSplitFillRuntime: {
        status: output.status,
        ok: result?.ok,
        scenarios: result ? Object.fromEntries(Object.entries(result.scenarios).map(([id, scenario]) => [id, {
          status: scenario.status,
          count: `${scenario.actualGroupCount}/${scenario.expectedGroupCount}`,
          ratio: scenario.areaCoverageRatio,
          axis: scenario.axisConsistency,
        }])) : null,
        errors: result?.errors,
      },
    }));

    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);

    for (const scenarioId of SCENARIOS) {
      const scenario = result!.scenarios[scenarioId];
      expect(scenario.status).toBe("pass");
      expect(scenario.actualGroupCount).toBe(scenario.expectedGroupCount);
      expect(scenario.groups).toHaveLength(scenario.expectedGroupCount);
      expect(scenario.allGroupsNonzero).toBe(true);
      expect(scenario.allGroupsContained).toBe(true);
      expect(scenario.layoutFillsScenario).toBe(true);
      expect(scenario.fillConsistent).toBe(true);
      expect(scenario.areaCoverageRatio).toBeGreaterThanOrEqual(0.9);
      expect(scenario.axisConsistency.passed).toBe(true);
    }

    expect(result!.scenarios.horizontal.axisConsistency.checked).toBe("horizontal");
    expect(result!.scenarios.vertical.axisConsistency.checked).toBe("vertical");
    expect(result!.scenarios["four-pane"].actualGroupCount).toBe(4);
    expect(result!.scenarios["six-pane"].actualGroupCount).toBe(6);
  }, SMOKE_TIMEOUT_MS + 25_000);
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
