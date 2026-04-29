import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/editor-popout-disabled-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorPopoutDisabledRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 15_000;

interface EditorPopoutDisabledRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  modelSnapshot: {
    globalPopoutDisabled: boolean;
    globalFloatIconDisabled: boolean;
    tabsPopoutDisabled: boolean;
    subLayoutsRemoved: boolean;
  };
  runtimeDom: {
    mounted: boolean;
    tabPopoutIconCount: number;
    floatingWindowCount: number;
  };
  programmaticActions: {
    tearOffResult: string | null;
    popoutTabNoop: boolean;
    createPopoutNoop: boolean;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorPopoutDisabledRuntimeSmokeResult;
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

describe("editor popout disabled runtime system smoke", () => {
  test("does not render flexlayout popout icons and ignores programmatic popout actions", async () => {
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
    expect(result?.modelSnapshot.globalPopoutDisabled).toBe(true);
    expect(result?.modelSnapshot.globalFloatIconDisabled).toBe(true);
    expect(result?.modelSnapshot.tabsPopoutDisabled).toBe(true);
    expect(result?.modelSnapshot.subLayoutsRemoved).toBe(true);
    expect(result?.runtimeDom.mounted).toBe(true);
    expect(result?.runtimeDom.tabPopoutIconCount).toBe(0);
    expect(result?.runtimeDom.floatingWindowCount).toBe(0);
    expect(result?.programmaticActions.tearOffResult).toBeNull();
    expect(result?.programmaticActions.popoutTabNoop).toBe(true);
    expect(result?.programmaticActions.createPopoutNoop).toBe(true);
    expect(result?.ok).toBe(true);
    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
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
  return {
    ...parsed,
    exitCode,
  };
}
