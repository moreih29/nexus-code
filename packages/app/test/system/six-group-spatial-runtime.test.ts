import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveElectronBinary } from "./electron-binary";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/six-group-spatial-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusSixGroupSpatialRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 30_000;
const SIX_GROUP_BASE_FILES = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts", "epsilon.ts", "zeta.ts"];
const DIRECTIONS = ["left", "right", "up", "down"] as const;
const ACTIVE_TABSET_MARKER_CLASS = "flexlayout__tabset-selected";

type SpatialDirection = typeof DIRECTIONS[number];

interface SixGroupSpatialRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  sixGroupFixture: {
    baseFiles: string[];
    openedTabTitles: string[];
    populatedGroupCount: number;
    topology: "row" | "column" | "mixed" | "unknown";
    groups: Array<{
      id: string;
      active: boolean;
      tabTitles: string[];
      rect: { x: number; y: number; width: number; height: number };
    }>;
  };
  keyboardContract: {
    expectedBindings: Record<SpatialDirection, string>;
    expectedCommands: Record<SpatialDirection, string>;
    bindingByDirection: Record<SpatialDirection, string | null>;
    commandPresentByDirection: Record<SpatialDirection, boolean>;
    missingBindings: string[];
    missingCommands: string[];
  };
  spatialMovement: {
    directionResults: Array<{
      direction: SpatialDirection;
      probeFile: string;
      startGroupId: string | null;
      expectedNeighborGroupId: string | null;
      actualGroupId: string | null;
      activeGroupIdAfter: string | null;
      passed: boolean;
      reason?: string;
    }>;
    edgeStopResults: Array<{
      direction: SpatialDirection;
      probeFile: string;
      edgeGroupId: string | null;
      actualGroupId: string | null;
      activeGroupIdAfter: string | null;
      passed: boolean;
      reason?: string;
    }>;
    deterministicContracts: Array<{
      topology: "row" | "column" | "mixed";
      directionCount: number;
      edgeStopCount: number;
    }>;
  };
  visualSanity: {
    activeMarkerClass: string;
    activeGroupId: string | null;
    inactiveGroupId: string | null;
    activeBackground: string | null;
    inactiveBackground: string | null;
    activeGroupHasMarker: boolean;
    inactiveGroupHasMarker: boolean;
    activeLuminance: number | null;
    inactiveLuminance: number | null;
    delta: number | null;
    passed: boolean;
    reason?: string;
  };
  t14Dependency: {
    missingSpatialKeyboardImplementation: boolean;
    missingBindings: string[];
    missingCommands: string[];
    movementFailures: string[];
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: SixGroupSpatialRuntimeSmokeResult;
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

describe("six group spatial keyboard runtime system smoke", () => {
  test("enforces six-group spatial neighbor movement, no-wrap edges, and active/inactive flexlayout marker state", async () => {
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
      sixGroupSpatialRuntime: {
        status: output.status,
        ok: result?.ok,
        topology: result?.sixGroupFixture.topology,
        populatedGroupCount: result?.sixGroupFixture.populatedGroupCount,
        missingBindings: result?.keyboardContract.missingBindings,
        missingCommands: result?.keyboardContract.missingCommands,
        directionFailures: result?.spatialMovement.directionResults.filter((entry) => !entry.passed),
        edgeFailures: result?.spatialMovement.edgeStopResults.filter((entry) => !entry.passed),
        visualSanity: result?.visualSanity,
        t14Dependency: result?.t14Dependency,
      },
    }));

    expect(output.suspiciousMessages).toEqual([]);
    expect(result).toBeDefined();
    expect(result?.productionPath.appShellMounted).toBe(true);
    expect(result?.productionPath.editorGroupsPartMounted).toBe(true);
    expect(result?.productionPath.editorGridProvider).toBe("flexlayout-model");
    expect(result?.productionPath.flexlayoutProviderMatched).toBe(true);
    expect(result?.sixGroupFixture.baseFiles).toEqual(SIX_GROUP_BASE_FILES);
    expect(result?.sixGroupFixture.openedTabTitles).toEqual(expect.arrayContaining(SIX_GROUP_BASE_FILES));
    expect(result?.sixGroupFixture.populatedGroupCount).toBe(6);
    expect(result?.keyboardContract.expectedBindings).toEqual({
      left: "Cmd+Alt+ArrowLeft",
      right: "Cmd+Alt+ArrowRight",
      up: "Cmd+Alt+ArrowUp",
      down: "Cmd+Alt+ArrowDown",
    });
    expect(result?.keyboardContract.missingBindings).toEqual([]);
    expect(result?.keyboardContract.missingCommands).toEqual([]);
    expect(result?.spatialMovement.directionResults.map((entry) => entry.direction).sort()).toEqual([...DIRECTIONS].sort());
    expect(result?.spatialMovement.directionResults.every((entry) => entry.passed)).toBe(true);
    expect(result?.spatialMovement.edgeStopResults.map((entry) => entry.direction).sort()).toEqual([...DIRECTIONS].sort());
    expect(result?.spatialMovement.edgeStopResults.every((entry) => entry.passed)).toBe(true);
    expect(result?.spatialMovement.deterministicContracts).toEqual([
      { topology: "row", directionCount: 4, edgeStopCount: 4 },
      { topology: "column", directionCount: 4, edgeStopCount: 4 },
      { topology: "mixed", directionCount: 4, edgeStopCount: 4 },
    ]);
    expect(result?.visualSanity.activeMarkerClass).toBe(ACTIVE_TABSET_MARKER_CLASS);
    expect(result?.visualSanity.activeGroupHasMarker).toBe(true);
    expect(result?.visualSanity.inactiveGroupHasMarker).toBe(false);
    expect(result?.visualSanity.passed).toBe(true);
    expect(result?.t14Dependency.missingSpatialKeyboardImplementation).toBe(false);
    expect(result?.errors).toEqual([]);
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
