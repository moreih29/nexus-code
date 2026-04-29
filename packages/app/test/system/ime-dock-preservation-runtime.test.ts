import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/ime-dock-preservation-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusImeDockPreservationRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const SCENARIO_NAMES = [
  "monaco-editor-drag-tab-cycle",
  "xterm-korean-input-around-dock-move",
  "xterm-ime-overlay-rebind-after-terminal-move",
  "splitter-pointermove-during-composition",
] as const;

type ImeDockScenarioName = typeof SCENARIO_NAMES[number];

interface ImeDockScenarioResult {
  name: ImeDockScenarioName;
  passed: boolean;
  targetKind: "monaco" | "xterm";
  sameCompositionSession: boolean;
  composition: {
    starts: number;
    updates: number;
    ends: number;
    cancelCount: number;
    forcedFinishCount: number;
    blurWhileComposingCount: number;
    unmountDuringCompositionCount: number;
    startSessionId: number | null;
    endSessionId: number | null;
    finalCommittedText: string | null;
    targetConnectedAtEnd: boolean;
  };
  operationLog: string[];
  reason?: string;
}

interface ImeDockPreservationRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: ImeDockScenarioResult[];
  aggregate: {
    scenarioCount: number;
    passedScenarioCount: number;
    totalCompositionCancelCount: number;
    totalForcedFinishCount: number;
    allSameCompositionSession: boolean;
  };
  latency: {
    sampleCount: number;
    samplesMs: number[];
    p95Ms: number;
    thresholdSource: "design.md";
    thresholdMs: number | null;
    thresholdFound: boolean;
  };
  limitations: string[];
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: ImeDockPreservationRuntimeSmokeResult;
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

describe("IME dock preservation runtime system smoke", () => {
  test("preserves one Korean composition session through Monaco dock drag, xterm dock move/rebind, and splitter pointermove", async () => {
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

    const designP95ThresholdMs = readDesignP95ThresholdMs();
    const smokeUrlObject = new URL(SMOKE_HTML_PATH, baseUrl);
    if (designP95ThresholdMs !== null) {
      smokeUrlObject.searchParams.set("designP95ThresholdMs", String(designP95ThresholdMs));
    }
    const output = await runElectronSmoke(smokeUrlObject.href);
    const result = output.rendererResult;

    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.scenarios.map((scenario) => scenario.name)).toEqual(SCENARIO_NAMES);
    expect(result?.aggregate.scenarioCount).toBe(4);
    expect(result?.aggregate.passedScenarioCount).toBe(4);
    expect(result?.aggregate.totalCompositionCancelCount).toBe(0);
    expect(result?.aggregate.totalForcedFinishCount).toBe(0);
    expect(result?.aggregate.allSameCompositionSession).toBe(true);

    for (const scenario of result?.scenarios ?? []) {
      expect(scenario.passed).toBe(true);
      expect(scenario.sameCompositionSession).toBe(true);
      expect(scenario.composition.starts).toBe(1);
      expect(scenario.composition.ends).toBe(1);
      expect(scenario.composition.cancelCount).toBe(0);
      expect(scenario.composition.forcedFinishCount).toBe(0);
      expect(scenario.composition.unmountDuringCompositionCount).toBe(0);
      expect(scenario.composition.targetConnectedAtEnd).toBe(true);
    }
    const overlayRebindScenario = result?.scenarios.find((scenario) =>
      scenario.name === "xterm-ime-overlay-rebind-after-terminal-move"
    );
    expect(overlayRebindScenario?.operationLog.some((entry) =>
      entry.includes("overlay:") && entry.includes("editorVisible=visible") && entry.includes("sameTextarea=true")
    )).toBe(true);

    expect(result?.latency.sampleCount).toBeGreaterThanOrEqual(9);
    expect(result?.latency.p95Ms).toBeGreaterThanOrEqual(0);
    expect(result?.latency.thresholdSource).toBe("design.md");
    expect(result?.latency.thresholdMs).toBe(designP95ThresholdMs);
    expect(result?.latency.thresholdFound).toBe(designP95ThresholdMs !== null);
    if (designP95ThresholdMs !== null) {
      expect(result?.latency.p95Ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(designP95ThresholdMs);
    }

    console.info(JSON.stringify({
      imeDockPreservationRuntime: {
        scenarios: result?.scenarios.map((scenario) => ({
          name: scenario.name,
          passed: scenario.passed,
          cancelCount: scenario.composition.cancelCount,
          forcedFinishCount: scenario.composition.forcedFinishCount,
          sameCompositionSession: scenario.sameCompositionSession,
        })),
        latencyP95Ms: result?.latency.p95Ms,
        designMdP95ThresholdMs: designP95ThresholdMs,
        thresholdNote: designP95ThresholdMs === null
          ? "No numeric p95 threshold found in .nexus/context/design.md; measurement recorded without inventing a gate."
          : "Numeric p95 threshold found in .nexus/context/design.md and enforced.",
      },
    }));
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
  const output = {
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

function readDesignP95ThresholdMs(): number | null {
  const designPath = resolve(REPO_ROOT, ".nexus/context/design.md");
  const source = readFileSync(designPath, "utf8");
  const p95Line = source
    .split(/\r?\n/)
    .find((line) => /p95/i.test(line) && /지연|latency|delay|keystroke|glyph/i.test(line));
  const match = p95Line?.match(/(?:p95|P95)[^\n\d]*(\d+(?:\.\d+)?)\s*ms|(?:\d+(?:\.\d+)?)\s*ms[^\n]*(?:p95|P95)/);
  if (!match) {
    return null;
  }
  const numericToken = match[0].match(/\d+(?:\.\d+)?/);
  return numericToken ? Number(numericToken[0]) : null;
}
