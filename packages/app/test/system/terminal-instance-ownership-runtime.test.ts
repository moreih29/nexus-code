import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/terminal-instance-ownership-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusTerminalInstanceOwnershipRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

type RuntimePhase =
  | "after-first-attach"
  | "after-same-host-attach"
  | "after-detach"
  | "after-different-host-attach"
  | "after-close-tab";

interface RuntimePhaseSnapshot {
  phase: RuntimePhase;
  terminalCreateCount: number;
  webglCreateCount: number;
  terminalOpenCount: number;
  terminalOpenHostIds: string[];
  terminalLoadAddonCount: number;
  terminalLoadedWebglAddonIds: number[];
  terminalFocusCount: number;
  terminalDisposeCount: number;
  webglDisposeCount: number;
  mountedHostId: string | null;
  terminalInstanceId: number | null;
  webglAddonId: number | null;
}

interface TerminalInstanceOwnershipRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarioResults: Array<{
    name: string;
    passed: boolean;
    evidence: Record<string, unknown>;
  }>;
  phaseSnapshots: RuntimePhaseSnapshot[];
  lifecycle: {
    closeTabResult: boolean;
    disposeCalledBeforeClose: boolean;
    sameTerminalInstanceAfterHostChange: boolean;
    webglAddonReusedAfterHostChange: boolean;
    terminalCreateCount: number;
    webglCreateCount: number;
    terminalDisposeCount: number;
    webglDisposeCount: number;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: TerminalInstanceOwnershipRuntimeSmokeResult;
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

describe("terminal instance ownership runtime system smoke", () => {
  test("preserves one xterm/WebglAddon instance across detach and host migration until closeTab", async () => {
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
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.scenarioResults).toHaveLength(5);
    expect(result?.scenarioResults.map((scenario) => [scenario.name, scenario.passed])).toEqual([
      ["first attach creates one instance", true],
      ["same host attach twice keeps open count at one", true],
      ["detach preserves instance without dispose", true],
      ["different host reopens same instance and reuses WebglAddon without dispose", true],
      ["closeTab disposes once", true],
    ]);

    const snapshots = new Map(result?.phaseSnapshots.map((snapshot) => [snapshot.phase, snapshot]));
    const afterFirstAttach = snapshots.get("after-first-attach");
    const afterSameHostAttach = snapshots.get("after-same-host-attach");
    const afterDetach = snapshots.get("after-detach");
    const afterDifferentHostAttach = snapshots.get("after-different-host-attach");
    const afterCloseTab = snapshots.get("after-close-tab");

    expect(afterFirstAttach).toMatchObject({
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalOpenCount: 1,
      terminalOpenHostIds: ["host-a"],
      terminalLoadAddonCount: 1,
      terminalLoadedWebglAddonIds: [1],
      terminalFocusCount: 1,
      terminalDisposeCount: 0,
      mountedHostId: "host-a",
      terminalInstanceId: 1,
      webglAddonId: 1,
    });
    expect(afterSameHostAttach).toMatchObject({
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalOpenCount: 1,
      terminalOpenHostIds: ["host-a"],
      terminalLoadAddonCount: 1,
      terminalDisposeCount: 0,
      mountedHostId: "host-a",
      terminalInstanceId: 1,
      webglAddonId: 1,
    });
    expect(afterDetach).toMatchObject({
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalOpenCount: 1,
      terminalDisposeCount: 0,
      mountedHostId: null,
      terminalInstanceId: 1,
      webglAddonId: 1,
    });
    expect(afterDifferentHostAttach).toMatchObject({
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalOpenCount: 2,
      terminalOpenHostIds: ["host-a", "host-b"],
      terminalLoadAddonCount: 1,
      terminalDisposeCount: 0,
      mountedHostId: "host-b",
      terminalInstanceId: 1,
      webglAddonId: 1,
    });
    expect(afterCloseTab).toMatchObject({
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalOpenCount: 2,
      terminalDisposeCount: 1,
      mountedHostId: null,
      terminalInstanceId: 1,
      webglAddonId: 1,
    });
    expect(result?.lifecycle).toMatchObject({
      closeTabResult: true,
      disposeCalledBeforeClose: false,
      sameTerminalInstanceAfterHostChange: true,
      webglAddonReusedAfterHostChange: true,
      terminalCreateCount: 1,
      webglCreateCount: 1,
      terminalDisposeCount: 1,
      webglDisposeCount: 0,
    });
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
