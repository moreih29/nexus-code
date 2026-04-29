import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const ENTRY_PATH = resolve(import.meta.dir, "editor-drop-runtime.entry.tsx");
const FIXTURE_HTML_PATH = resolve(import.meta.dir, "editor-drop-runtime.fixture.html");
const SMOKE_HTML_PATH = "/test/system/editor-drop-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorDropRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 35_000;

interface EditorDropRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  scenarios: {
    centerDrop: { status: string; expectedEdge?: string; afterGroupCount: number; beforeGroupCount: number };
    rightSplit: { status: string; expectedEdge?: string; afterGroupCount: number; beforeGroupCount: number };
    bottomSplit: { status: string; expectedEdge?: string; afterGroupCount: number; beforeGroupCount: number };
    altCorner: { status: string; expectedEdge?: string; overlay: { cornerZones: boolean; edge: string | null } | null };
    splitterHover: { status: string; splitterFound: boolean; overlayMountedAfterHover: boolean };
    rectRecalculation: { status: string; firstMatchesTarget: boolean; secondMatchesTarget: boolean; targetChanged: boolean; rapidHoverCount: number };
    folderOnly: { status: string; tooltipText: string | null; dropEffect: string; tabCountBefore: number; tabCountAfter: number; folderTabOpened: boolean };
    multiFileOrder: { status: string; paths: string[]; readPathsDuringScenario: string[]; tabLabelIndexes: number[] };
    osFinderExternalPath: { status: string; expectedWorkspacePath: string; readPathsDuringScenario: string[]; tabOpened: boolean; dataTransferMode: string; limitation: string | null };
    escapeCancel: { status: string; tabOpened: boolean; ariaLiveAfterEscape: string };
    ariaLive: { status: string; centerText: string; splitText: string; folderText: string; clearedAfterEscape: boolean };
  };
  dataTransferSynthesis: {
    workspaceMime: string;
    osFileMode: string;
    limitations: string[];
  };
  readPaths: string[];
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorDropRuntimeSmokeResult;
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

describe("editor drop runtime system smoke", () => {
  test("covers center/right/bottom/Alt/drop-cancel/folder/multi-file/OS-path D&D scenarios", async () => {
    expect(existsSync(ENTRY_PATH)).toBe(true);
    expect(existsSync(FIXTURE_HTML_PATH)).toBe(true);

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
      editorDropRuntime: {
        status: output.status,
        ok: result?.ok,
        scenarioStatuses: result ? Object.fromEntries(Object.entries(result.scenarios).map(([name, scenario]) => [name, scenario.status])) : null,
        dataTransferSynthesis: result?.dataTransferSynthesis,
        errors: result?.errors,
      },
    }));

    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.productionPath.appShellMounted).toBe(true);
    expect(result?.productionPath.editorGroupsPartMounted).toBe(true);
    expect(result?.productionPath.editorGridProvider).toBe("flexlayout-model");
    expect(result?.productionPath.flexlayoutProviderMatched).toBe(true);

    expect(result?.scenarios.centerDrop.status).toBe("pass");
    expect(result?.scenarios.centerDrop.expectedEdge).toBe("center");
    expect(result?.scenarios.centerDrop.afterGroupCount).toBe(result?.scenarios.centerDrop.beforeGroupCount);
    expect(result?.scenarios.rightSplit.status).toBe("pass");
    expect(result?.scenarios.rightSplit.afterGroupCount).toBe(result!.scenarios.rightSplit.beforeGroupCount + 1);
    expect(result?.scenarios.bottomSplit.status).toBe("pass");
    expect(result?.scenarios.bottomSplit.afterGroupCount).toBe(result!.scenarios.bottomSplit.beforeGroupCount + 1);
    expect(result?.scenarios.altCorner.status).toBe("pass");
    expect(result?.scenarios.altCorner.overlay?.edge).toBe("top-left");
    expect(result?.scenarios.altCorner.overlay?.cornerZones).toBe(true);

    expect(result?.scenarios.splitterHover.status).toBe("pass");
    expect(result?.scenarios.splitterHover.splitterFound).toBe(true);
    expect(result?.scenarios.splitterHover.overlayMountedAfterHover).toBe(false);
    expect(result?.scenarios.rectRecalculation.status).toBe("pass");
    expect(result?.scenarios.rectRecalculation.firstMatchesTarget).toBe(true);
    expect(result?.scenarios.rectRecalculation.secondMatchesTarget).toBe(true);
    expect(result?.scenarios.rectRecalculation.targetChanged).toBe(true);
    expect(result?.scenarios.rectRecalculation.rapidHoverCount).toBeGreaterThanOrEqual(6);

    expect(result?.scenarios.folderOnly.status).toBe("pass");
    expect(result?.scenarios.folderOnly.tooltipText).toBe("Drop files, not folders");
    expect(result?.scenarios.folderOnly.dropEffect).toBe("none");
    expect(result?.scenarios.folderOnly.tabCountAfter).toBe(result?.scenarios.folderOnly.tabCountBefore);
    expect(result?.scenarios.folderOnly.folderTabOpened).toBe(false);

    expect(result?.scenarios.multiFileOrder.status).toBe("pass");
    expect(result?.scenarios.multiFileOrder.readPathsDuringScenario).toEqual(result?.scenarios.multiFileOrder.paths);
    expect(result?.scenarios.multiFileOrder.tabLabelIndexes.every((index) => index >= 0)).toBe(true);

    expect(result?.scenarios.osFinderExternalPath.status).toBe("pass");
    expect(result?.scenarios.osFinderExternalPath.readPathsDuringScenario).toContain("src/from-finder.ts");
    expect(result?.scenarios.osFinderExternalPath.tabOpened).toBe(true);
    expect(result?.dataTransferSynthesis.osFileMode).toMatch(/native-data-transfer-files|synthetic-files-fallback/);

    expect(result?.scenarios.escapeCancel.status).toBe("pass");
    expect(result?.scenarios.escapeCancel.tabOpened).toBe(false);
    expect(result?.scenarios.escapeCancel.ariaLiveAfterEscape).toBe("");
    expect(result?.scenarios.ariaLive.status).toBe("pass");
    expect(result?.scenarios.ariaLive.centerText).toMatch(/Drop into Editor Group \d+/);
    expect(result?.scenarios.ariaLive.splitText).toMatch(/Split right of Editor Group \d+/);
    expect(result?.scenarios.ariaLive.folderText).toBe("Drop files, not folders");
    expect(result?.scenarios.ariaLive.clearedAfterEscape).toBe(true);
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
  const output: ElectronSmokeOutput = {
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
