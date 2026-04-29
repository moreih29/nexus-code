import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const ENTRY_PATH = resolve(import.meta.dir, "editor-empty-group-policy-runtime.entry.tsx");
const FIXTURE_HTML_PATH = resolve(import.meta.dir, "editor-empty-group-policy-runtime.fixture.html");
const SMOKE_HTML_PATH = "/test/system/editor-empty-group-policy-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusEditorEmptyGroupPolicyRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 25_000;

interface RuntimeGroupSnapshot {
  groupId: string;
  tabCount: number;
  rect: { width: number; height: number };
  nonzero: boolean;
  contained: boolean;
}

interface EditorEmptyGroupPolicyRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: {
    closeCenterRelayout: {
      status: string;
      beforeGroupIds: string[];
      afterGroupIds: string[];
      centerRemoved: boolean;
      remainingGroupsNonzero: boolean;
      remainingGroupsContained: boolean;
      layoutFillsContainer: boolean;
      areaCoverageRatio: number;
      groups: RuntimeGroupSnapshot[];
    };
    closeAllFinalEmpty: {
      status: string;
      groupCount: number;
      finalGroupTabCount: number | null;
      placeholderVisible: boolean;
      placeholderRole: string | null;
      placeholderAriaLabel: string | null;
      serializedTabSetCount: number;
      finalTabSetPreserved: boolean;
    };
    splitEmptyNoop: {
      status: string;
      returnedGroupId: string | null;
      modelUnchanged: boolean;
      groupCount: number;
      finalGroupTabCount: number | null;
    };
    splitCommandDuplicate: {
      status: string;
      splitGroupId: string | null;
      logicalTabOccurrences: number;
      logicalPathOccurrences: number;
      sourceRetainedTab: boolean;
      targetDuplicatedTab: boolean;
      activeGroupId: string | null;
    };
    splitSizingAuto: {
      status: string;
      firstSplitWeights: number[] | null;
      resizedWeightsBeforeSecondSplit: number[] | null;
      secondSplitWeights: number[] | null;
      firstSplitEqual: boolean;
      userResizeObserved: boolean;
      activeGroupHalvedAfterResize: boolean;
    };
    finalEmptyPersistence: {
      status: string;
      serializedTabSetCount: number;
      serializedFinalTabSetHasNoTabs: boolean;
      restoredGroupCount: number;
      restoredFinalGroupTabCount: number | null;
      serviceRoundTripLossless: boolean;
      workspaceStorageLossless: boolean;
      corruptLayoutIsNull: boolean;
      fallbackGroupCount: number;
      fallbackFinalGroupTabCount: number | null;
    };
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: EditorEmptyGroupPolicyRuntimeSmokeResult;
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

describe("editor empty-group policy runtime system smoke", () => {
  test("covers empty group deletion, final placeholder, split duplication, split sizing, and persistence", async () => {
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
      editorEmptyGroupPolicyRuntime: {
        status: output.status,
        ok: result?.ok,
        scenarios: result ? Object.fromEntries(Object.entries(result.scenarios).map(([id, scenario]) => [id, scenario.status])) : null,
        errors: result?.errors,
      },
    }));

    expect(output.status).toBe("ok");
    expect(output.exitCode).toBe(0);
    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);

    expect(result?.scenarios.closeCenterRelayout.status).toBe("pass");
    expect(result?.scenarios.closeCenterRelayout.beforeGroupIds).toEqual(["group_left", "group_center", "group_right"]);
    expect(result?.scenarios.closeCenterRelayout.afterGroupIds).toEqual(["group_left", "group_right"]);
    expect(result?.scenarios.closeCenterRelayout.centerRemoved).toBe(true);
    expect(result?.scenarios.closeCenterRelayout.remainingGroupsNonzero).toBe(true);
    expect(result?.scenarios.closeCenterRelayout.remainingGroupsContained).toBe(true);
    expect(result?.scenarios.closeCenterRelayout.layoutFillsContainer).toBe(true);
    expect(result!.scenarios.closeCenterRelayout.areaCoverageRatio).toBeGreaterThanOrEqual(0.85);
    expect(result?.scenarios.closeCenterRelayout.groups).toHaveLength(2);

    expect(result?.scenarios.closeAllFinalEmpty.status).toBe("pass");
    expect(result?.scenarios.closeAllFinalEmpty.groupCount).toBe(1);
    expect(result?.scenarios.closeAllFinalEmpty.finalGroupTabCount).toBe(0);
    expect(result?.scenarios.closeAllFinalEmpty.placeholderVisible).toBe(true);
    expect(result?.scenarios.closeAllFinalEmpty.placeholderRole).toBe("status");
    expect(result?.scenarios.closeAllFinalEmpty.placeholderAriaLabel).toBe("Empty editor group");
    expect(result?.scenarios.closeAllFinalEmpty.serializedTabSetCount).toBe(1);
    expect(result?.scenarios.closeAllFinalEmpty.finalTabSetPreserved).toBe(true);

    expect(result?.scenarios.splitEmptyNoop.status).toBe("pass");
    expect(result?.scenarios.splitEmptyNoop.returnedGroupId).toBeNull();
    expect(result?.scenarios.splitEmptyNoop.modelUnchanged).toBe(true);
    expect(result?.scenarios.splitEmptyNoop.groupCount).toBe(1);
    expect(result?.scenarios.splitEmptyNoop.finalGroupTabCount).toBe(0);

    expect(result?.scenarios.splitCommandDuplicate.status).toBe("pass");
    expect(result?.scenarios.splitCommandDuplicate.splitGroupId).toBe("group_duplicate_right");
    expect(result?.scenarios.splitCommandDuplicate.logicalTabOccurrences).toBe(2);
    expect(result?.scenarios.splitCommandDuplicate.logicalPathOccurrences).toBe(2);
    expect(result?.scenarios.splitCommandDuplicate.sourceRetainedTab).toBe(true);
    expect(result?.scenarios.splitCommandDuplicate.targetDuplicatedTab).toBe(true);
    expect(result?.scenarios.splitCommandDuplicate.activeGroupId).toBe("group_duplicate_right");

    expect(result?.scenarios.splitSizingAuto.status).toBe("pass");
    expect(result?.scenarios.splitSizingAuto.firstSplitWeights).toEqual([100, 100, 100]);
    expect(result?.scenarios.splitSizingAuto.resizedWeightsBeforeSecondSplit).toEqual([60, 20, 20]);
    expect(result?.scenarios.splitSizingAuto.secondSplitWeights).toEqual([30, 30, 20, 20]);
    expect(result?.scenarios.splitSizingAuto.firstSplitEqual).toBe(true);
    expect(result?.scenarios.splitSizingAuto.userResizeObserved).toBe(true);
    expect(result?.scenarios.splitSizingAuto.activeGroupHalvedAfterResize).toBe(true);

    expect(result?.scenarios.finalEmptyPersistence.status).toBe("pass");
    expect(result?.scenarios.finalEmptyPersistence.serializedTabSetCount).toBe(1);
    expect(result?.scenarios.finalEmptyPersistence.serializedFinalTabSetHasNoTabs).toBe(true);
    expect(result?.scenarios.finalEmptyPersistence.restoredGroupCount).toBe(1);
    expect(result?.scenarios.finalEmptyPersistence.restoredFinalGroupTabCount).toBe(0);
    expect(result?.scenarios.finalEmptyPersistence.serviceRoundTripLossless).toBe(true);
    expect(result?.scenarios.finalEmptyPersistence.workspaceStorageLossless).toBe(true);
    expect(result?.scenarios.finalEmptyPersistence.corruptLayoutIsNull).toBe(true);
    expect(result?.scenarios.finalEmptyPersistence.fallbackGroupCount).toBe(1);
    expect(result?.scenarios.finalEmptyPersistence.fallbackFinalGroupTabCount).toBe(0);
  }, SMOKE_TIMEOUT_MS + 15_000);
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
