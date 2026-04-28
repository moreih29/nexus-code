import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/app-file-tree-refresh-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusAppFileTreeRefreshSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: {
    ok: boolean;
    errors: string[];
    allowedErrors: string[];
    iconLoadingEvents: Array<{
      phase: string;
      path: string;
      source: string;
      state: string;
      elementId: number;
    }>;
    iconLoadingEventCount: number;
    iconIdentityChanges: Array<{
      phase: string;
      path: string;
      previousElementId: number;
      nextElementId: number;
      previousSource: string;
      nextSource: string;
    }>;
    iconIdentityChangeCount: number;
    monacoWorkerMessages: string[];
    treeReadCount: number;
    watchEventCount: number;
    terminalOpenCount: number;
    gitInvokeActions: string[];
    visiblePathSamples: string[][];
    visiblePaths: string[];
    expandedPaths: string[];
    sourceControlErrorSeen: boolean;
    sourceControlRouteExercised: boolean;
    explorerSideBarRestored: boolean;
    fileTreeMountedInExplorerSideBar: boolean;
    contextMenuOpened: boolean;
    reason?: string;
  };
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

describe("app file tree refresh runtime smoke", () => {
  test("keeps file tree icons visually stable and Monaco workers clean through App-level refreshes", async () => {
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

    expect(output.status).toBe("ok");
    expect(output.suspiciousMessages).toEqual([]);
    expect(output.rendererResult?.ok).toBe(true);
    expect(output.rendererResult?.errors).toEqual([]);
    expect(output.rendererResult?.iconLoadingEvents).toEqual([]);
    expect(output.rendererResult?.iconLoadingEventCount).toBe(0);
    expect(output.rendererResult?.monacoWorkerMessages).toEqual([]);
    expect(output.rendererResult?.fileTreeMountedInExplorerSideBar).toBe(true);
    expect(output.rendererResult?.sourceControlRouteExercised).toBe(true);
    expect(output.rendererResult?.explorerSideBarRestored).toBe(true);
    expect(output.rendererResult?.sourceControlErrorSeen).toBe(true);
    expect(output.rendererResult?.gitInvokeActions).toEqual(expect.arrayContaining(["status", "branch_list", "watch_start"]));
    expect(output.rendererResult?.watchEventCount).toBe(8);
    expect(output.rendererResult?.treeReadCount).toBeGreaterThanOrEqual(9);
    expect(output.rendererResult?.treeReadCount).toBeLessThanOrEqual(24);
    expect(output.rendererResult?.visiblePaths).toContain("src/components/Button.tsx");
    expect(output.rendererResult?.expandedPaths).toEqual(expect.arrayContaining(["src", "src/components"]));
    expect(output.rendererResult?.visiblePathSamples.every((sample) => sample.includes("src/components/Button.tsx"))).toBe(true);
    expect(output.rendererResult?.contextMenuOpened).toBe(true);
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
