import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/workspace-layout-persist-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusWorkspaceLayoutPersistRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const CONSECUTIVE_RUNS = 5;
const WORKSPACE_IDS = ["ws_layout_alpha", "ws_layout_beta", "ws_layout_gamma", "ws_layout_delta_empty"];
const WORKSPACE_STORAGE_KEYS = WORKSPACE_IDS.map((workspaceId) => `nx.layout.${workspaceId}`);

interface WorkspaceLayoutPersistRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  registeredWorkspaceIds: string[];
  layoutSummaries: Array<{
    workspaceId: string;
    editorGroupCount: number;
    bottomPanelPosition: string;
    terminalInEditorArea: boolean;
  }>;
  restartPolicy: {
    workspaceId: string;
    persistedTerminalTabIds: string[];
    restoredTerminalTabIds: string[];
    groupIdsBeforeRestart: string[];
    groupIdsAfterRestart: string[];
    terminalTabsDropped: boolean;
    groupLayoutSurvives: boolean;
    bottomPanelSurvives: boolean;
  };
  localStorageKeys: Array<{
    workspaceId: string;
    key: string;
    exists: boolean;
    parsedMatchesExpected: boolean;
  }>;
  roundTrip: Array<{
    workspaceId: string;
    jsonLossless: boolean;
    workspaceServiceLossless: boolean;
    editorGroupsLossless: boolean;
    localStorageLossless: boolean;
  }>;
  switchRestore: {
    cycles: number;
    totalSwitches: number;
    exactRestoreCount: number;
    failures: string[];
  };
  corruptFallback: {
    didNotThrow: boolean;
    corruptLayoutIsNull: boolean;
    defaultEditorGroupRestored: boolean;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: WorkspaceLayoutPersistRuntimeSmokeResult;
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

describe("workspace layout persistence runtime system smoke", () => {
  test("restores four workspace-specific editor/bottom-panel layouts through Electron renderer five consecutive runs", async () => {
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
    const runResults: WorkspaceLayoutPersistRuntimeSmokeResult[] = [];

    for (let runIndex = 1; runIndex <= CONSECUTIVE_RUNS; runIndex += 1) {
      const output = await runElectronSmoke(smokeUrl);
      const result = output.rendererResult;

      expect(output.status).toBe("ok");
      expect(output.suspiciousMessages).toEqual([]);
      expect(result?.ok).toBe(true);
      expect(result?.errors).toEqual([]);
      expect(result?.registeredWorkspaceIds).toEqual(WORKSPACE_IDS);
      expect(result?.layoutSummaries).toEqual([
        {
          workspaceId: "ws_layout_alpha",
          editorGroupCount: 4,
          bottomPanelPosition: "bottom",
          terminalInEditorArea: false,
        },
        {
          workspaceId: "ws_layout_beta",
          editorGroupCount: 1,
          bottomPanelPosition: "right",
          terminalInEditorArea: false,
        },
        {
          workspaceId: "ws_layout_gamma",
          editorGroupCount: 1,
          bottomPanelPosition: "bottom",
          terminalInEditorArea: false,
        },
        {
          workspaceId: "ws_layout_delta_empty",
          editorGroupCount: 1,
          bottomPanelPosition: "bottom",
          terminalInEditorArea: false,
        },
      ]);
      expect(result?.restartPolicy).toEqual({
        workspaceId: "ws_layout_gamma",
        persistedTerminalTabIds: ["terminal_ws_layout_gamma_gamma_terminal"],
        restoredTerminalTabIds: [],
        groupIdsBeforeRestart: ["gamma_group_terminal"],
        groupIdsAfterRestart: ["gamma_group_terminal"],
        terminalTabsDropped: true,
        groupLayoutSurvives: true,
        bottomPanelSurvives: true,
      });
      expect(result?.localStorageKeys.map((entry) => entry.key)).toEqual(WORKSPACE_STORAGE_KEYS);
      expect(result?.localStorageKeys.every((entry) => entry.exists && entry.parsedMatchesExpected)).toBe(true);
      expect(result?.roundTrip.every((entry) => {
        return entry.jsonLossless &&
          entry.workspaceServiceLossless &&
          entry.editorGroupsLossless &&
          entry.localStorageLossless;
      })).toBe(true);
      expect(result?.switchRestore.cycles).toBe(5);
      expect(result?.switchRestore.totalSwitches).toBe(20);
      expect(result?.switchRestore.exactRestoreCount).toBe(20);
      expect(result?.switchRestore.failures).toEqual([]);
      expect(result?.corruptFallback).toEqual({
        didNotThrow: true,
        corruptLayoutIsNull: true,
        defaultEditorGroupRestored: true,
      });

      runResults.push(result as WorkspaceLayoutPersistRuntimeSmokeResult);
    }

    console.info(JSON.stringify({
      workspaceLayoutPersistRuntimeRuns: runResults.map((result, index) => ({
        run: index + 1,
        ok: result.ok,
        restored: result.switchRestore.exactRestoreCount,
        restartPolicy: result.restartPolicy,
        localStorageKeys: result.localStorageKeys.map((entry) => entry.key),
      })),
    }));
  }, (SMOKE_TIMEOUT_MS + 10_000) * CONSECUTIVE_RUNS);
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
