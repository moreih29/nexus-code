import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/editor-terminal-dock-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorTerminalDockRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const TERMINAL_ALPHA_ID = "terminal_dock_alpha";
const TERMINAL_BETA_ID = "terminal_dock_beta";

interface RuntimeScenarioResult {
  name: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  reason?: string;
}

interface RuntimeTerminalSnapshot {
  sessionId: string;
  instanceId: number | null;
  writeLog: string[];
  mountHostDescriptions: string[];
  currentHostDescription: string | null;
  currentHostArea: string | null;
  currentHostGroupId: string | null;
  focusCount: number;
  fitCount: number;
  detachCount: number;
  disposeCount: number;
}

interface EditorTerminalDockRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: RuntimeScenarioResult[];
  dockState: {
    bottomDetachedTerminalIds: string[];
    bottomAttachedTerminalIds: string[];
    editorTerminalTabIds: string[];
    uniqueEditorTerminalTabIds: string[];
    groupByTerminalId: Record<string, string | null>;
    groupsByTerminalId: Record<string, string[]>;
    centerMode: string;
    activeCenterArea: string;
  };
  ptyEvidence: {
    alphaInstanceIdBeforeMove: number | null;
    alphaInstanceIdAfterMove: number | null;
    alphaSameInstanceAfterMove: boolean;
    alphaWriteLog: string[];
    alphaDataEvents: string[];
    betaWriteLog: string[];
    terminalCreateCount: number;
  };
  terminalSnapshots: RuntimeTerminalSnapshot[];
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorTerminalDockRuntimeSmokeResult;
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

describe("editor terminal dock runtime system smoke", () => {
  test("moves terminals between bottom panel and editor groups while preserving PTY data and split layout", async () => {
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
      editorTerminalDockRuntime: {
        status: output.status,
        ok: result?.ok,
        scenarios: result?.scenarios.map((scenario) => [scenario.name, scenario.passed]),
        dockState: result?.dockState,
        ptyEvidence: result?.ptyEvidence,
        terminalSnapshots: result?.terminalSnapshots,
      },
    }));

    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.scenarios.map((scenario) => [scenario.name, scenario.passed])).toEqual([
      ["bottom-panel-to-editor move", true],
      ["editor split with terminal", true],
      ["two terminals dock in editor area", true],
      ["pty data preserved during move", true],
    ]);
    expect(result?.dockState.bottomDetachedTerminalIds.sort()).toEqual([TERMINAL_ALPHA_ID, TERMINAL_BETA_ID].sort());
    expect(result?.dockState.bottomAttachedTerminalIds).toEqual([]);
    expect(result?.dockState.uniqueEditorTerminalTabIds.sort()).toEqual([TERMINAL_ALPHA_ID, TERMINAL_BETA_ID].sort());
    expect(result?.dockState.editorTerminalTabIds.sort()).toEqual([TERMINAL_ALPHA_ID, TERMINAL_ALPHA_ID, TERMINAL_BETA_ID].sort());
    expect(result?.dockState.groupsByTerminalId[TERMINAL_ALPHA_ID]?.sort()).toEqual(["group_main", "group_terminal_split"].sort());
    expect(result?.dockState.groupByTerminalId[TERMINAL_ALPHA_ID]).toBe("group_main");
    expect(result?.dockState.groupByTerminalId[TERMINAL_BETA_ID]).toBe("group_main");
    expect(result?.ptyEvidence.alphaSameInstanceAfterMove).toBe(true);
    expect(result?.ptyEvidence.alphaWriteLog).toEqual([
      "alpha before move\r\n",
      "alpha during move\r\n",
      "alpha after editor attach\r\n",
    ]);
    expect(result?.ptyEvidence.alphaDataEvents).toEqual([
      "alpha before move\r\n",
      "alpha during move\r\n",
      "alpha after editor attach\r\n",
    ]);
    expect(result?.ptyEvidence.betaWriteLog).toEqual([
      "beta ready\r\n",
      "beta after editor attach\r\n",
    ]);
    expect(result?.ptyEvidence.terminalCreateCount).toBe(2);
    expect(result?.terminalSnapshots.every((snapshot) => snapshot.currentHostArea === "editor")).toBe(true);
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
