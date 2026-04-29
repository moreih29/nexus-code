import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/activity-bar-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusActivityBarRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const EXPECTED_VIEW_IDS = ["explorer", "search", "source-control", "tool", "session", "preview"];
const EXPECTED_VIEW_LABELS = ["Explorer", "Search", "Source Control", "Tool", "Session", "Preview"];

interface ActivityBarRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  expectedViewIds: string[];
  exposedViews: Array<{
    id: string;
    label: string;
    active: boolean;
  }>;
  exposedViewCount: number;
  clickTransitions: Array<{
    viewId: string;
    expectedLabel: string;
    activeContentId: string;
    contentText: string;
    matched: boolean;
  }>;
  collapseExpand: {
    cycles: number;
    toggleCount: number;
    states: Array<{
      cycle: number;
      phase: "collapsed" | "expanded";
      sideBarCollapsed: boolean;
      sideBarVisible: boolean;
      activityBarAttr: string;
      activeContentId: string | null;
    }>;
    finalCollapsed: boolean;
  };
  strictMode: {
    iterations: number;
    leakSignals: string[];
    leakSignalCount: number;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: ActivityBarRuntimeSmokeResult;
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

describe("activity bar runtime system smoke", () => {
  test("exposes default views, swaps Side Bar routes, and survives repeated collapse/expand", async () => {
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
    expect(result?.expectedViewIds).toEqual(EXPECTED_VIEW_IDS);
    expect(result?.exposedViewCount).toBe(6);
    expect(result?.exposedViews.map((view) => view.id)).toEqual(EXPECTED_VIEW_IDS);
    expect(result?.exposedViews.map((view) => view.label)).toEqual(EXPECTED_VIEW_LABELS);
    expect(result?.clickTransitions).toHaveLength(6);
    expect(result?.clickTransitions.map((transition) => transition.viewId)).toEqual(EXPECTED_VIEW_IDS);
    expect(result?.clickTransitions.every((transition) => transition.matched)).toBe(true);
    expect(result?.clickTransitions.map((transition) => transition.activeContentId)).toEqual(EXPECTED_VIEW_IDS);
    expect(result?.collapseExpand.cycles).toBe(5);
    expect(result?.collapseExpand.toggleCount).toBe(10);
    expect(result?.collapseExpand.finalCollapsed).toBe(false);
    expect(result?.collapseExpand.states).toHaveLength(10);
    expect(result?.collapseExpand.states.filter((state) => state.phase === "collapsed").every((state) => {
      return state.sideBarCollapsed && !state.sideBarVisible && state.activityBarAttr === "true";
    })).toBe(true);
    expect(result?.collapseExpand.states.filter((state) => state.phase === "expanded").every((state) => {
      return !state.sideBarCollapsed && state.sideBarVisible && state.activityBarAttr === "false";
    })).toBe(true);
    expect(result?.strictMode.iterations).toBe(5);
    expect(result?.strictMode.leakSignalCount).toBe(0);
    expect(result?.strictMode.leakSignals).toEqual([]);
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
