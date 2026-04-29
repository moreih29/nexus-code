import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/floating-workspace-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusFloatingWorkspaceRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;
const WORKSPACE_A_ID = "ws_floating_workspace_a";
const WORKSPACE_B_ID = "ws_floating_workspace_b";
const WORKSPACE_STORAGE_KEYS = [WORKSPACE_A_ID, WORKSPACE_B_ID].map((workspaceId) => `nx.layout.${workspaceId}`);

interface FloatingPanelGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloatingWorkspaceRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  workspaceSwitch: {
    createdInWorkspaceId: string;
    switchedToWorkspaceId: string;
    returnedToWorkspaceId: string;
    activeWorkspaceSequence: string[];
  };
  hiddenNotUnmounted: {
    floatingNodeExistedBeforeSwitch: boolean;
    floatingNodeExistedWhileWorkspaceBActive: boolean;
    sameFloatingNodeWhileWorkspaceBActive: boolean;
    sameFloatingNodeAfterReturn: boolean;
    hiddenWhileWorkspaceBActive: boolean;
    hiddenMode: string;
  };
  geometryRestore: {
    beforeSwitch: FloatingPanelGeometry | null;
    afterReturn: FloatingPanelGeometry | null;
    deltaPx: FloatingPanelGeometry | null;
    deltaIsZero: boolean;
  };
  localStorageScope: {
    expectedKeys: string[];
    observedLayoutKeys: string[];
    onlyWorkspaceScopedKeys: boolean;
    entries: Array<{
      workspaceId: string;
      key: string;
      exists: boolean;
      hasEditorGroupsTree: boolean;
      floatingSubLayoutCount: number;
      floatingTabIds: string[];
      floatingRects: FloatingPanelGeometry[];
      includesFloatingState: boolean;
      containsOtherWorkspaceFloatingTab: boolean;
    }>;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: FloatingWorkspaceRuntimeSmokeResult;
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

describe("floating workspace runtime system smoke", () => {
  test("keeps workspace A floating panel mounted-but-hidden across workspace B and restores geometry exactly", async () => {
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
    expect(result?.errors).toEqual([]);
    expect(result?.workspaceSwitch).toEqual({
      createdInWorkspaceId: WORKSPACE_A_ID,
      switchedToWorkspaceId: WORKSPACE_B_ID,
      returnedToWorkspaceId: WORKSPACE_A_ID,
      activeWorkspaceSequence: [WORKSPACE_A_ID, WORKSPACE_B_ID, WORKSPACE_A_ID],
    });
    expect(result?.hiddenNotUnmounted).toMatchObject({
      floatingNodeExistedBeforeSwitch: true,
      floatingNodeExistedWhileWorkspaceBActive: true,
      sameFloatingNodeWhileWorkspaceBActive: true,
      sameFloatingNodeAfterReturn: true,
      hiddenWhileWorkspaceBActive: true,
    });
    expect(result?.hiddenNotUnmounted.hiddenMode).toBe("visibility:hidden");
    expect(result?.geometryRestore.deltaPx).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    expect(result?.geometryRestore.deltaIsZero).toBe(true);
    expect(result?.localStorageScope.expectedKeys).toEqual(WORKSPACE_STORAGE_KEYS);
    expect(result?.localStorageScope.observedLayoutKeys).toEqual(WORKSPACE_STORAGE_KEYS);
    expect(result?.localStorageScope.onlyWorkspaceScopedKeys).toBe(true);
    expect(result?.localStorageScope.entries).toHaveLength(2);
    expect(result?.localStorageScope.entries[0]).toMatchObject({
      workspaceId: WORKSPACE_A_ID,
      key: `nx.layout.${WORKSPACE_A_ID}`,
      exists: true,
      hasEditorGroupsTree: true,
      floatingSubLayoutCount: 1,
      floatingTabIds: ["tab_workspace_a_floating"],
      includesFloatingState: true,
      containsOtherWorkspaceFloatingTab: false,
    });
    expect(result?.localStorageScope.entries[1]).toMatchObject({
      workspaceId: WORKSPACE_B_ID,
      key: `nx.layout.${WORKSPACE_B_ID}`,
      exists: true,
      hasEditorGroupsTree: true,
      floatingSubLayoutCount: 0,
      floatingTabIds: [],
      includesFloatingState: false,
      containsOtherWorkspaceFloatingTab: false,
    });
    expect(result?.ok).toBe(true);
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
