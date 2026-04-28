import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/file-tree-folder-toggle-runtime.fixture.html";
const SMOKE_TIMEOUT_MS = 20_000;

interface ElectronSmokeOutput {
  status: string;
  rendererResult?: {
    ok: boolean;
    errors: string[];
    toggleClicks: number;
    visiblePaths: string[];
    expandedPaths: string[];
    contextMenuOpened?: boolean;
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

describe("file tree folder toggle runtime smoke", () => {
  test("expands nested folders in a real Electron renderer without Presence/update-depth errors", async () => {
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
    expect(output.rendererResult?.toggleClicks).toBeGreaterThanOrEqual(14);
    expect(output.rendererResult?.visiblePaths).toContain("src/components/Button.tsx");
    expect(output.rendererResult?.contextMenuOpened).toBe(true);
  }, SMOKE_TIMEOUT_MS + 10_000);
});

async function runElectronSmoke(smokeUrl: string): Promise<ElectronSmokeOutput> {
  const child = spawn(String(electronBinary), [RUNNER_PATH, smokeUrl, String(SMOKE_TIMEOUT_MS)], {
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
