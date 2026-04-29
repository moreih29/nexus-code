import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/editor-pane-footerless-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorPaneFooterlessRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

interface EditorPaneFooterlessRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  editorPane: {
    mounted: boolean;
    internalTablistCount: number;
    internalTabCount: number;
    internalTabActionCount: number;
    flexlayoutTabCount: number;
  };
  statusBar: {
    mounted: boolean;
    separateFromEditorPane: boolean;
    separateFromEditorGroupsPart: boolean;
    initialKind: string | null;
    afterTerminalKind: string | null;
    afterFileKind: string | null;
    fileText: string;
    terminalText: string;
  };
  contextMenu: {
    opened: boolean;
    menuItemIds: string[];
    copyRelativePathCalls: string[];
    splitRightCalls: string[];
  };
  middleClick: {
    attempted: boolean;
    tabRemoved: boolean;
    closeCalls: string[];
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorPaneFooterlessRuntimeSmokeResult;
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

describe("editor pane footerless runtime system smoke", () => {
  test("keeps flexlayout tabs as the only tab UI and switches the separate status bar", async () => {
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
    expect(result?.editorPane.mounted).toBe(true);
    expect(result?.editorPane.internalTablistCount).toBe(0);
    expect(result?.editorPane.internalTabCount).toBe(0);
    expect(result?.editorPane.internalTabActionCount).toBe(0);
    expect(result?.editorPane.flexlayoutTabCount).toBeGreaterThanOrEqual(3);
    expect(result?.statusBar.mounted).toBe(true);
    expect(result?.statusBar.separateFromEditorPane).toBe(true);
    expect(result?.statusBar.separateFromEditorGroupsPart).toBe(true);
    expect(result?.statusBar.initialKind).toBe("file");
    expect(result?.statusBar.afterTerminalKind).toBe("terminal");
    expect(result?.statusBar.afterFileKind).toBe("file");
    expect(result?.statusBar.fileText).toContain("LSP: ready");
    expect(result?.statusBar.fileText).toContain("TypeScript");
    expect(result?.statusBar.terminalText).toContain("zsh");
    expect(result?.statusBar.terminalText).toContain("nexus-footerless-runtime");
    expect(result?.contextMenu.opened).toBe(true);
    expect(result?.contextMenu.menuItemIds).toEqual(expect.arrayContaining([
      "close",
      "copy-relative-path",
      "split-right",
    ]));
    expect(result?.contextMenu.copyRelativePathCalls).toEqual(["src/footerless-one.ts:relative"]);
    expect(result?.contextMenu.splitRightCalls).toEqual(["group_main:footerless_file_one"]);
    expect(result?.middleClick.attempted).toBe(true);
    expect(result?.middleClick.tabRemoved).toBe(true);
    expect(result?.middleClick.closeCalls).toContain("group_main:footerless_file_two");
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
  if (exitCode !== 0) {
    throw new Error(
      `Electron smoke failed with status ${parsed.status}.\n` +
        `rendererResult=${JSON.stringify(parsed.rendererResult, null, 2)}\n` +
        `suspiciousMessages=${JSON.stringify(parsed.suspiciousMessages, null, 2)}\n` +
        `logs=${JSON.stringify(parsed.logs, null, 2)}\n` +
        `stderr=${stderr}`,
    );
  }

  return {
    ...parsed,
    exitCode,
  };
}
