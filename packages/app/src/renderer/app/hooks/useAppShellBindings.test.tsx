import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { keyboardRegistryStore } from "../../stores/keyboard-registry";
import type { AppCommandBindings } from "../useAppCommands";
import type { EditorBindings } from "../useEditorBindings";
import type { ExplorerBindings } from "../useExplorerBindings";
import type { ResizeDragBindings } from "../useResizeDrag";
import type { SourceControlBindings } from "../useSourceControlBindings";
import type { AppServices } from "../wiring";
import {
  useAppShellBindings,
  type AppShellBindingHooks,
  type AppShellBindings,
} from "./useAppShellBindings";

const workspaceId = "ws_alpha" as WorkspaceId;
const activeWorkspace = {
  id: workspaceId,
  displayName: "Alpha",
  absolutePath: "/tmp/alpha",
};

describe("useAppShellBindings", () => {
  test("calls binding hooks in AppShell dependency order", () => {
    const callOrder: string[] = [];
    const services = createServicesStub();
    const bindingHooks = createBindingHookStubs(callOrder);

    renderBindings({ services, bindingHooks });

    expect(callOrder).toEqual([
      "editorBindings",
      "appCommands",
      "explorerBindings",
      "sourceControlBindings",
      "resizeBindings",
    ]);
  });

  test("passes active workspace, services, and upstream bindings through the hook chain", () => {
    const callOrder: string[] = [];
    const services = createServicesStub();
    const bindingHooks = createBindingHookStubs(callOrder);

    const bindings = renderBindings({ services, bindingHooks });

    expect(bindingHooks.inputs.editor?.activeWorkspaceId).toBe(workspaceId);
    expect(bindingHooks.inputs.editor?.documentsService).toBe(services.editorDocuments);
    expect(bindingHooks.inputs.editor?.openWorkspaces).toEqual([activeWorkspace]);
    expect(bindingHooks.inputs.appCommands?.editorBindings).toBe(bindingHooks.returnValues.editorBindings);
    expect(bindingHooks.inputs.appCommands?.workspaceStore).toBe(services.workspace);
    expect(bindingHooks.inputs.explorer?.activeWorkspaceId).toBe(workspaceId);
    expect(bindingHooks.inputs.explorer?.showTerminalPanel).toBe(bindingHooks.returnValues.appCommands.showTerminalPanel);
    expect(bindingHooks.inputs.sourceControl?.activeWorkspace).toBe(activeWorkspace);
    expect(bindingHooks.inputs.sourceControl?.sourceControlStore).toBe(services.sourceControl);
    expect(bindingHooks.inputs.resize?.activityBarStore).toBe(services.activityBar);
    expect(bindings.editorBindings).toBe(bindingHooks.returnValues.editorBindings);
    expect(bindings.appCommands).toBe(bindingHooks.returnValues.appCommands);
    expect(bindings.explorerBindings).toBe(bindingHooks.returnValues.explorerBindings);
    expect(bindings.sourceControlBindings).toBe(bindingHooks.returnValues.sourceControlBindings);
    expect(bindings.resizeBindings).toBe(bindingHooks.returnValues.resizeBindings);
    expect(bindings.keybindingRegistry).toBe(keyboardRegistryStore);
  });
});

function renderBindings({
  services,
  bindingHooks,
}: {
  services: AppServices;
  bindingHooks: AppShellBindingHooks & ReturnType<typeof createBindingHookStubs>;
}): AppShellBindings {
  let captured: AppShellBindings | null = null;

  function Probe() {
    captured = useAppShellBindings({
      services,
      activeWorkspace,
      openWorkspaces: [activeWorkspace],
    }, bindingHooks);
    return <div data-probe="app-shell-bindings" />;
  }

  expect(renderToStaticMarkup(<Probe />)).toContain("app-shell-bindings");
  if (!captured) {
    throw new Error("useAppShellBindings did not render.");
  }
  return captured;
}

function createBindingHookStubs(callOrder: string[]) {
  const returnValues = {
    editorBindings: { marker: "editor" } as unknown as EditorBindings,
    appCommands: {
      marker: "commands",
      showTerminalPanel() {},
    } as unknown as AppCommandBindings,
    explorerBindings: { marker: "explorer" } as unknown as ExplorerBindings,
    sourceControlBindings: { marker: "source-control" } as unknown as SourceControlBindings,
    resizeBindings: { marker: "resize" } as unknown as ResizeDragBindings,
  };
  const inputs: Record<string, unknown> = {};

  return {
    inputs: inputs as {
      editor?: Parameters<AppShellBindingHooks["useEditorBindings"]>[0];
      appCommands?: Parameters<AppShellBindingHooks["useAppCommands"]>[0];
      explorer?: Parameters<AppShellBindingHooks["useExplorerBindings"]>[0];
      sourceControl?: Parameters<AppShellBindingHooks["useSourceControlBindings"]>[0];
      resize?: Parameters<AppShellBindingHooks["useResizeDrag"]>[0];
    },
    returnValues,
    useEditorBindings(input: Parameters<AppShellBindingHooks["useEditorBindings"]>[0]) {
      callOrder.push("editorBindings");
      inputs.editor = input;
      return returnValues.editorBindings;
    },
    useAppCommands(input: Parameters<AppShellBindingHooks["useAppCommands"]>[0]) {
      callOrder.push("appCommands");
      inputs.appCommands = input;
      return returnValues.appCommands;
    },
    useExplorerBindings(input: Parameters<AppShellBindingHooks["useExplorerBindings"]>[0]) {
      callOrder.push("explorerBindings");
      inputs.explorer = input;
      return returnValues.explorerBindings;
    },
    useSourceControlBindings(input: Parameters<AppShellBindingHooks["useSourceControlBindings"]>[0]) {
      callOrder.push("sourceControlBindings");
      inputs.sourceControl = input;
      return returnValues.sourceControlBindings;
    },
    useResizeDrag(input: Parameters<AppShellBindingHooks["useResizeDrag"]>[0]) {
      callOrder.push("resizeBindings");
      inputs.resize = input;
      return returnValues.resizeBindings;
    },
  } satisfies AppShellBindingHooks & {
    inputs: unknown;
    returnValues: typeof returnValues;
  };
}

function createServicesStub(): AppServices {
  return {
    activityBar: { marker: "activityBar" },
    bottomPanel: { marker: "bottomPanel" },
    editorDocuments: { marker: "editorDocuments" },
    editorGroups: { marker: "editorGroups" },
    editorWorkspace: { marker: "editorWorkspace" },
    fileClipboard: { marker: "fileClipboard" },
    files: { marker: "files" },
    git: { marker: "git" },
    harnessBadge: { marker: "harnessBadge" },
    harnessSession: { marker: "harnessSession" },
    harnessToolFeed: { marker: "harnessToolFeed" },
    lsp: { marker: "lsp" },
    search: { marker: "search" },
    sourceControl: { marker: "sourceControl" },
    terminal: { marker: "terminal" },
    workspace: { marker: "workspace" },
  } as unknown as AppServices;
}
