import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronBinary from "electron";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const APP_ROOT = resolve(import.meta.dir, "../..");
const RUNNER_PATH = resolve(import.meta.dir, "electron-renderer-smoke-runner.cjs");
const SMOKE_HTML_PATH = "/test/system/app-shell-strict-mode-runtime.fixture.html";
const RESULT_GLOBAL_NAME = "__nexusAppShellStrictModeRuntimeSmokeResult";
const SMOKE_TIMEOUT_MS = 30_000;
const STRICT_MODE_ITERATIONS = 5;
const EXPECTED_CORE_SERVICE_KEYS = [
  "activityBar",
  "bottomPanel",
  "editorDocuments",
  "editorGroups",
  "editorWorkspace",
  "files",
  "git",
  "lsp",
  "search",
  "sourceControl",
  "terminal",
];

interface BridgeListenerCounts {
  claudeConsent: number;
  editor: number;
  harness: number;
  search: number;
  sourceControl: number;
  terminal: number;
  workspace: number;
}

interface WarningCapture {
  getSnapshotShouldBeCached: number;
  maximumUpdateDepthExceeded: number;
  messages: string[];
}

interface AppShellZoneMounts {
  activityBar: boolean;
  sideBar: boolean;
  editorGroups: boolean;
  bottomPanel: boolean;
  terminalPane: boolean;
}

interface StrictModeCycleResult {
  cycle: number;
  zoneMounts: AppShellZoneMounts;
  listenerCountsWhileMounted: BridgeListenerCounts;
  activeLifecycleCountWhileMounted: number;
  terminalShellMountedWhileMountedCount: number;
  rootDomNodeCountWhileMounted: number;
  listenerCountsAfterUnmount: BridgeListenerCounts;
  listenerLeakCount: number;
  activeLifecycleCountAfterUnmount: number;
  terminalShellMountedAfterUnmountCount: number;
  rootDomNodeCountAfterUnmount: number;
  extraBodyNodeCountAfterUnmount: number;
  domLeakCount: number;
  warningsAfterUnmount: WarningCapture;
}

interface ServiceCreationRecord {
  id: number;
  cycle: number;
  serviceKeys: string[];
  expectedServiceKeys: string[];
  missingServiceKeys: string[];
  coreServiceInstanceIds: Record<string, number | null>;
  terminalLifecycleExposed: boolean;
}

interface ServiceLifecycleSummary {
  expectedServiceKeys: string[];
  expectedServiceCount: number;
  createdServiceSetCount: number;
  creationRecords: ServiceCreationRecord[];
  missingServiceKeys: string[];
  lifecycleMountCount: number;
  lifecycleUnmountCount: number;
  mountUnmountBalanced: boolean;
  finalActiveLifecycleCount: number;
  finalBridgeListenerCounts: BridgeListenerCounts;
  finalBridgeListenerLeakCount: number;
  finalTerminalShellMountedCount: number;
  terminalLifecycleExposed: boolean;
  perCycle: StrictModeCycleResult[];
}

interface AppShellStrictModeRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  strictMode: {
    iterations: number;
    stableIterations: number;
  };
  warningCapture: WarningCapture;
  zoneMounts: AppShellZoneMounts[];
  serviceLifecycle: ServiceLifecycleSummary;
  domLeak: {
    totalLeakCount: number;
    perCycle: Array<{
      cycle: number;
      rootDomNodeCountAfterUnmount: number;
      extraBodyNodeCountAfterUnmount: number;
      domLeakCount: number;
    }>;
  };
  reason?: string;
}

interface ElectronSmokeOutput {
  status: string;
  exitCode: number | null;
  rendererResult?: AppShellStrictModeRuntimeSmokeResult;
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

describe("app shell strict mode runtime system smoke", () => {
  test("keeps production AppShell stable across StrictMode mount/unmount cycles", async () => {
    viteServer = await createServer({
      configFile: false,
      root: APP_ROOT,
      logLevel: "error",
      resolve: {
        alias: {
          "@": resolve(APP_ROOT, "src/renderer"),
        },
      },
      plugins: [appShellStrictModeLifecycleProbePlugin(), react()],
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
    expect(result?.strictMode.iterations).toBe(STRICT_MODE_ITERATIONS);
    expect(result?.strictMode.stableIterations).toBe(STRICT_MODE_ITERATIONS);
    expect(result?.warningCapture.getSnapshotShouldBeCached).toBe(0);
    expect(result?.warningCapture.maximumUpdateDepthExceeded).toBe(0);
    expect(result?.warningCapture.messages).toEqual([]);
    expect(result?.zoneMounts).toHaveLength(STRICT_MODE_ITERATIONS);
    expect(result?.zoneMounts.every((mounts) => Object.values(mounts).every(Boolean))).toBe(true);
    expect(result?.serviceLifecycle.expectedServiceKeys).toEqual(EXPECTED_CORE_SERVICE_KEYS);
    expect(result?.serviceLifecycle.expectedServiceCount).toBe(EXPECTED_CORE_SERVICE_KEYS.length);
    expect(result?.serviceLifecycle.missingServiceKeys).toEqual([]);
    expect(result?.serviceLifecycle.createdServiceSetCount).toBeGreaterThanOrEqual(STRICT_MODE_ITERATIONS);
    expect(result?.serviceLifecycle.lifecycleMountCount).toBeGreaterThanOrEqual(STRICT_MODE_ITERATIONS);
    expect(result?.serviceLifecycle.lifecycleUnmountCount).toBe(result?.serviceLifecycle.lifecycleMountCount);
    expect(result?.serviceLifecycle.mountUnmountBalanced).toBe(true);
    expect(result?.serviceLifecycle.finalActiveLifecycleCount).toBe(0);
    expect(result?.serviceLifecycle.finalBridgeListenerLeakCount).toBe(0);
    expect(result?.serviceLifecycle.finalTerminalShellMountedCount).toBe(0);
    expect(result?.serviceLifecycle.terminalLifecycleExposed).toBe(true);
    expect(result?.serviceLifecycle.perCycle).toHaveLength(STRICT_MODE_ITERATIONS);
    expect(result?.serviceLifecycle.perCycle.every((cycle) => cycle.activeLifecycleCountWhileMounted > 0)).toBe(true);
    expect(result?.serviceLifecycle.perCycle.every((cycle) => cycle.terminalShellMountedWhileMountedCount > 0)).toBe(true);
    expect(result?.serviceLifecycle.perCycle.every((cycle) => cycle.listenerLeakCount === 0)).toBe(true);
    expect(result?.serviceLifecycle.perCycle.every((cycle) => cycle.activeLifecycleCountAfterUnmount === 0)).toBe(true);
    expect(result?.serviceLifecycle.perCycle.every((cycle) => cycle.terminalShellMountedAfterUnmountCount === 0)).toBe(true);
    expect(result?.domLeak.totalLeakCount).toBe(0);
    expect(result?.domLeak.perCycle.every((cycle) => cycle.domLeakCount === 0)).toBe(true);
  }, SMOKE_TIMEOUT_MS + 10_000);
});

function appShellStrictModeLifecycleProbePlugin(): Plugin {
  return {
    name: "nexus-app-shell-strict-mode-lifecycle-probe",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (!normalizedId.endsWith("/src/renderer/app/wiring.ts")) {
        return null;
      }

      const createNeedle = "export function createAppServices(";
      const lifecycleNeedle = "export function mountAppServiceLifecycles(";
      if (!code.includes(createNeedle) || !code.includes(lifecycleNeedle)) {
        throw new Error("Unable to install app-shell strict mode lifecycle probe: wiring exports moved.");
      }

      const transformed = code
        .replace(createNeedle, "function __nexusOriginalCreateAppServices(")
        .replace(lifecycleNeedle, "function __nexusOriginalMountAppServiceLifecycles(");

      return {
        code: `${transformed}\n\n${lifecycleProbeSnippet()}`,
        map: null,
      };
    },
  };
}

function lifecycleProbeSnippet(): string {
  return String.raw`
type __NexusAppShellStrictModeLifecycleProbe = {
  onServicesCreated?: (services: AppServices) => void;
  onLifecycleMounted?: (services: Pick<AppServices, "terminal">) => void;
  onLifecycleUnmounted?: (services: Pick<AppServices, "terminal">) => void;
};

function __nexusGetAppShellStrictModeLifecycleProbe(): __NexusAppShellStrictModeLifecycleProbe | null {
  return (globalThis as typeof globalThis & {
    __nexusAppShellStrictModeLifecycleProbe?: __NexusAppShellStrictModeLifecycleProbe;
  }).__nexusAppShellStrictModeLifecycleProbe ?? null;
}

export function createAppServices(dependencies: AppServiceDependencies = {}): AppServices {
  const services = __nexusOriginalCreateAppServices(dependencies);
  __nexusGetAppShellStrictModeLifecycleProbe()?.onServicesCreated?.(services);
  return services;
}

export function mountAppServiceLifecycles(services: Pick<AppServices, "terminal">): () => void {
  const unmount = __nexusOriginalMountAppServiceLifecycles(services);
  __nexusGetAppShellStrictModeLifecycleProbe()?.onLifecycleMounted?.(services);
  let didUnmount = false;

  return () => {
    if (didUnmount) {
      return;
    }

    didUnmount = true;
    try {
      unmount();
    } finally {
      __nexusGetAppShellStrictModeLifecycleProbe()?.onLifecycleUnmounted?.(services);
    }
  };
}
`;
}

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
