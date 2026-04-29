import type { ITerminalAddon, ITerminalOptions } from "@xterm/xterm";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import {
  createTerminalService,
  type TerminalServiceStore,
  type TerminalServiceTerminalCreateOptions,
  type TerminalServiceTerminalLike,
  type TerminalServiceXtermDependencies,
} from "../../src/renderer/services/terminal-service";

const RESULT_GLOBAL_NAME = "__nexusTerminalInstanceOwnershipRuntimeSmokeResult";
const TAB_ID = "terminal_instance_ownership";
const WORKSPACE_ID = "ws_terminal_instance_ownership" as WorkspaceId;

type RuntimePhase =
  | "after-first-attach"
  | "after-same-host-attach"
  | "after-detach"
  | "after-different-host-attach"
  | "after-close-tab";

type ScenarioName =
  | "first attach creates one instance"
  | "same host attach twice keeps open count at one"
  | "detach preserves instance without dispose"
  | "different host reopens same instance and reuses WebglAddon without dispose"
  | "closeTab disposes once";

interface RuntimePhaseSnapshot {
  phase: RuntimePhase;
  terminalCreateCount: number;
  webglCreateCount: number;
  terminalOpenCount: number;
  terminalOpenHostIds: string[];
  terminalLoadAddonCount: number;
  terminalLoadedWebglAddonIds: number[];
  terminalFocusCount: number;
  terminalDisposeCount: number;
  webglDisposeCount: number;
  mountedHostId: string | null;
  terminalInstanceId: number | null;
  webglAddonId: number | null;
}

interface ScenarioResult {
  name: ScenarioName;
  passed: boolean;
  evidence: Record<string, unknown>;
}

interface TerminalInstanceOwnershipRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarioResults: ScenarioResult[];
  phaseSnapshots: RuntimePhaseSnapshot[];
  lifecycle: {
    closeTabResult: boolean;
    disposeCalledBeforeClose: boolean;
    sameTerminalInstanceAfterHostChange: boolean;
    webglAddonReusedAfterHostChange: boolean;
    terminalCreateCount: number;
    webglCreateCount: number;
    terminalDisposeCount: number;
    webglDisposeCount: number;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusTerminalInstanceOwnershipRuntimeSmokeResult?: TerminalInstanceOwnershipRuntimeSmokeResult;
  }
}

function runSmoke(): void {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root."));
      return;
    }

    const dependencies = new RuntimeXtermDependencies();
    const store = createTerminalService({}, dependencies);
    const firstHost = createHost(rootElement, "host-a");
    const secondHost = createHost(rootElement, "host-b");
    const phaseSnapshots: RuntimePhaseSnapshot[] = [];
    const detachCallbacks: Array<() => void> = [];

    store.getState().createTab({
      id: TAB_ID,
      workspaceId: WORKSPACE_ID,
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    detachCallbacks.push(store.getState().attachToHost(TAB_ID, firstHost, { focus: true }));
    phaseSnapshots.push(captureSnapshot("after-first-attach", store, dependencies));

    detachCallbacks.push(store.getState().attachToHost(TAB_ID, firstHost));
    phaseSnapshots.push(captureSnapshot("after-same-host-attach", store, dependencies));

    store.getState().detachFromHost(TAB_ID);
    phaseSnapshots.push(captureSnapshot("after-detach", store, dependencies));

    detachCallbacks.push(store.getState().attachToHost(TAB_ID, secondHost));
    phaseSnapshots.push(captureSnapshot("after-different-host-attach", store, dependencies));

    const closeTabResult = store.getState().closeTab(TAB_ID, "user-close");
    phaseSnapshots.push(captureSnapshot("after-close-tab", store, dependencies));

    for (const detach of detachCallbacks) {
      detach();
    }

    const scenarioResults = buildScenarioResults(phaseSnapshots, closeTabResult);
    const errors = scenarioResults
      .filter((scenario) => !scenario.passed)
      .map((scenario) => `${scenario.name}: ${JSON.stringify(scenario.evidence)}`);
    const afterClose = requireSnapshot(phaseSnapshots, "after-close-tab");
    const lifecycle = {
      closeTabResult,
      disposeCalledBeforeClose: phaseSnapshots
        .filter((snapshot) => snapshot.phase !== "after-close-tab")
        .some((snapshot) => snapshot.terminalDisposeCount > 0),
      sameTerminalInstanceAfterHostChange:
        requireSnapshot(phaseSnapshots, "after-first-attach").terminalInstanceId ===
        requireSnapshot(phaseSnapshots, "after-different-host-attach").terminalInstanceId,
      webglAddonReusedAfterHostChange:
        requireSnapshot(phaseSnapshots, "after-first-attach").webglAddonId ===
        requireSnapshot(phaseSnapshots, "after-different-host-attach").webglAddonId,
      terminalCreateCount: afterClose.terminalCreateCount,
      webglCreateCount: afterClose.webglCreateCount,
      terminalDisposeCount: afterClose.terminalDisposeCount,
      webglDisposeCount: afterClose.webglDisposeCount,
    };

    publishResult({
      ok: errors.length === 0,
      errors,
      scenarioResults,
      phaseSnapshots,
      lifecycle,
      reason: errors[0],
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function buildScenarioResults(
  phaseSnapshots: RuntimePhaseSnapshot[],
  closeTabResult: boolean,
): ScenarioResult[] {
  const afterFirstAttach = requireSnapshot(phaseSnapshots, "after-first-attach");
  const afterSameHostAttach = requireSnapshot(phaseSnapshots, "after-same-host-attach");
  const afterDetach = requireSnapshot(phaseSnapshots, "after-detach");
  const afterDifferentHostAttach = requireSnapshot(phaseSnapshots, "after-different-host-attach");
  const afterCloseTab = requireSnapshot(phaseSnapshots, "after-close-tab");

  return [
    {
      name: "first attach creates one instance",
      passed:
        afterFirstAttach.terminalCreateCount === 1 &&
        afterFirstAttach.webglCreateCount === 1 &&
        afterFirstAttach.terminalOpenCount === 1 &&
        afterFirstAttach.terminalOpenHostIds[0] === "host-a" &&
        afterFirstAttach.terminalLoadAddonCount === 1 &&
        afterFirstAttach.mountedHostId === "host-a",
      evidence: afterFirstAttach,
    },
    {
      name: "same host attach twice keeps open count at one",
      passed:
        afterSameHostAttach.terminalCreateCount === 1 &&
        afterSameHostAttach.webglCreateCount === 1 &&
        afterSameHostAttach.terminalOpenCount === 1 &&
        afterSameHostAttach.terminalLoadAddonCount === 1 &&
        afterSameHostAttach.terminalDisposeCount === 0 &&
        afterSameHostAttach.mountedHostId === "host-a",
      evidence: afterSameHostAttach,
    },
    {
      name: "detach preserves instance without dispose",
      passed:
        afterDetach.mountedHostId === null &&
        afterDetach.terminalDisposeCount === 0 &&
        afterDetach.terminalInstanceId === afterFirstAttach.terminalInstanceId &&
        afterDetach.webglAddonId === afterFirstAttach.webglAddonId,
      evidence: afterDetach,
    },
    {
      name: "different host reopens same instance and reuses WebglAddon without dispose",
      passed:
        afterDifferentHostAttach.terminalCreateCount === 1 &&
        afterDifferentHostAttach.webglCreateCount === 1 &&
        afterDifferentHostAttach.terminalOpenCount === 2 &&
        afterDifferentHostAttach.terminalOpenHostIds.join(",") === "host-a,host-b" &&
        afterDifferentHostAttach.terminalLoadAddonCount === 1 &&
        afterDifferentHostAttach.terminalDisposeCount === 0 &&
        afterDifferentHostAttach.terminalInstanceId === afterFirstAttach.terminalInstanceId &&
        afterDifferentHostAttach.webglAddonId === afterFirstAttach.webglAddonId &&
        afterDifferentHostAttach.mountedHostId === "host-b",
      evidence: afterDifferentHostAttach,
    },
    {
      name: "closeTab disposes once",
      passed:
        closeTabResult &&
        afterCloseTab.terminalDisposeCount === 1 &&
        afterCloseTab.mountedHostId === null &&
        afterCloseTab.terminalInstanceId === afterFirstAttach.terminalInstanceId,
      evidence: {
        closeTabResult,
        ...afterCloseTab,
      },
    },
  ];
}

function captureSnapshot(
  phase: RuntimePhase,
  store: TerminalServiceStore,
  dependencies: RuntimeXtermDependencies,
): RuntimePhaseSnapshot {
  const terminal = dependencies.terminals[0] ?? null;
  const webglAddon = dependencies.webglAddons[0] ?? null;

  return {
    phase,
    terminalCreateCount: dependencies.terminals.length,
    webglCreateCount: dependencies.webglAddons.length,
    terminalOpenCount: terminal?.openedHosts.length ?? 0,
    terminalOpenHostIds: terminal?.openedHosts.map(hostId).filter(isPresent) ?? [],
    terminalLoadAddonCount: terminal?.loadedAddons.length ?? 0,
    terminalLoadedWebglAddonIds: terminal?.loadedAddons.map(addonId).filter(isPresent) ?? [],
    terminalFocusCount: terminal?.focusCount ?? 0,
    terminalDisposeCount: terminal?.disposeCount ?? 0,
    webglDisposeCount: webglAddon?.disposeCount ?? 0,
    mountedHostId: hostId(store.getState().getMountedHost(TAB_ID)),
    terminalInstanceId: terminal?.id ?? null,
    webglAddonId: webglAddon?.id ?? null,
  };
}

function requireSnapshot(
  phaseSnapshots: readonly RuntimePhaseSnapshot[],
  phase: RuntimePhase,
): RuntimePhaseSnapshot {
  const snapshot = phaseSnapshots.find((candidate) => candidate.phase === phase);
  if (!snapshot) {
    throw new Error(`Missing runtime phase snapshot: ${phase}`);
  }
  return snapshot;
}

function createHost(rootElement: HTMLElement, id: string): HTMLElement {
  const host = document.createElement("section");
  host.dataset.terminalOwnershipHostId = id;
  rootElement.append(host);
  return host;
}

function hostId(host: HTMLElement | null | undefined): string | null {
  return host?.dataset.terminalOwnershipHostId ?? null;
}

function addonId(addon: ITerminalAddon): number | null {
  return addon instanceof RuntimeWebglAddon ? addon.id : null;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function publishResult(result: TerminalInstanceOwnershipRuntimeSmokeResult): void {
  window[RESULT_GLOBAL_NAME] = result;
}

function failedResult(reason: string): TerminalInstanceOwnershipRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    scenarioResults: [],
    phaseSnapshots: [],
    lifecycle: {
      closeTabResult: false,
      disposeCalledBeforeClose: false,
      sameTerminalInstanceAfterHostChange: false,
      webglAddonReusedAfterHostChange: false,
      terminalCreateCount: 0,
      webglCreateCount: 0,
      terminalDisposeCount: 0,
      webglDisposeCount: 0,
    },
    reason,
  };
}

function stringifyErrorPart(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class RuntimeWebglAddon implements ITerminalAddon {
  public activateCount = 0;
  public disposeCount = 0;

  public constructor(public readonly id: number) {}

  public activate(): void {
    this.activateCount += 1;
  }

  public dispose(): void {
    this.disposeCount += 1;
  }
}

class RuntimeTerminal implements TerminalServiceTerminalLike {
  public readonly loadedAddons: ITerminalAddon[] = [];
  public readonly openedHosts: HTMLElement[] = [];
  public readonly writes: string[] = [];
  public focusCount = 0;
  public disposeCount = 0;
  public detachCount = 0;
  public fitCount = 0;
  private mountedHost: HTMLElement | null = null;
  private disposed = false;

  public constructor(
    public readonly id: number,
    public readonly options?: ITerminalOptions,
    webglAddon?: ITerminalAddon,
  ) {
    if (webglAddon) {
      this.loadedAddons.push(webglAddon);
    }
  }

  public mount(parent: HTMLElement): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.mountedHost === parent) {
      this.fit();
      return true;
    }
    this.mountedHost = parent;
    this.openedHosts.push(parent);
    return true;
  }

  public detach(): void {
    if (this.disposed) {
      return;
    }
    this.detachCount += 1;
    this.mountedHost = null;
  }

  public fit(): void {
    if (this.disposed) {
      return;
    }
    this.fitCount += 1;
  }

  public focus(): void {
    if (this.disposed) {
      return;
    }
    this.focusCount += 1;
  }

  public write(data: string): void {
    if (this.disposed) {
      return;
    }
    this.writes.push(data);
  }

  public dispose(): void {
    this.disposed = true;
    this.mountedHost = null;
    this.disposeCount += 1;
  }
}

class RuntimeXtermDependencies implements TerminalServiceXtermDependencies {
  public readonly terminalOptions: Array<ITerminalOptions | undefined> = [];
  public readonly terminals: RuntimeTerminal[] = [];
  public readonly webglAddons: RuntimeWebglAddon[] = [];

  public createTerminal(options: TerminalServiceTerminalCreateOptions): TerminalServiceTerminalLike {
    this.terminalOptions.push(options.terminalOptions);
    const webglAddon = new RuntimeWebglAddon(this.webglAddons.length + 1);
    this.webglAddons.push(webglAddon);
    const terminal = new RuntimeTerminal(this.terminals.length + 1, options.terminalOptions, webglAddon);
    this.terminals.push(terminal);
    return terminal;
  }
}

void runSmoke();
