import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import {
  createAppServices,
  mountAppServiceLifecycles,
  SIDE_BAR_STORAGE_KEY,
  useAppServices,
  type AppServices,
} from "./wiring";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("useAppServices", () => {
  test("returns the centralized app service/store shape", () => {
    installRendererWindowStub();
    let services: AppServices | null = null;

    function Probe() {
      services = useAppServices();
      return <div data-probe="app-services" />;
    }

    expect(renderToStaticMarkup(<Probe />)).toContain("app-services");

    expect(Object.keys(services ?? {}).sort()).toEqual([
      "activityBar",
      "bottomPanel",
      "editorDocuments",
      "editorGroups",
      "editorWorkspace",
      "fileClipboard",
      "files",
      "git",
      "harnessBadge",
      "harnessSession",
      "harnessToolFeed",
      "lsp",
      "search",
      "sourceControl",
      "terminal",
      "workspace",
    ].sort());

    expect(services?.activityBar.getState().sideBarWidth).toBe(312);
    expect(typeof services?.workspace.getState().refreshSidebarState).toBe("function");
    expect(typeof services?.editorGroups.getState().openTab).toBe("function");
    expect(typeof services?.editorDocuments.getState().openDocument).toBe("function");
    expect(typeof services?.files.getState().refreshFileTree).toBe("function");
    expect(typeof services?.git.getState().replacePathBadges).toBe("function");
    expect(typeof services?.lsp.getState().applyDiagnosticsEvent).toBe("function");
    expect(typeof services?.terminal.getState().createTerminal).toBe("function");
    expect(typeof services?.terminal.getState().mountShell).toBe("function");
    expect(typeof services?.search.getState().startBridgeSubscription).toBe("function");
    expect(typeof services?.sourceControl.getState().startBridgeSubscription).toBe("function");
  });

  test("wires terminal service mount and unmount lifecycle", () => {
    installRendererWindowStub();
    const services = createAppServices();

    expect(services.terminal.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });

    const unmount = mountAppServiceLifecycles(services);
    expect(services.terminal.getState().getLifecycleSnapshot()).toEqual({ shellMounted: true });

    unmount();
    unmount();
    expect(services.terminal.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });
  });
});

function installRendererWindowStub(): void {
  const sidebarState: WorkspaceSidebarState = {
    openWorkspaces: [],
    activeWorkspaceId: null,
  };
  const disposable = { dispose() {} };

  globalThis.window = {
    localStorage: {
      getItem(key: string) {
        return key === SIDE_BAR_STORAGE_KEY ? JSON.stringify({ size: 312 }) : null;
      },
      setItem() {},
    },
    nexusWorkspace: {
      async getSidebarState() {
        return sidebarState;
      },
      async openFolder() {
        return sidebarState;
      },
      async activateWorkspace() {
        return sidebarState;
      },
      async closeWorkspace() {
        return sidebarState;
      },
      async restoreSession() {
        return sidebarState;
      },
      onSidebarStateChanged() {
        return disposable;
      },
    },
    nexusHarness: {
      onObserverEvent() {
        return disposable;
      },
    },
    nexusEditor: {
      async invoke() {
        throw new Error("Editor bridge invoke was not expected in useAppServices return-shape test.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusSearch: {
      async startSearch() {
        return {
          type: "search/lifecycle",
          action: "started",
          requestId: "request_1",
          workspaceId: "workspace_1",
          sessionId: "session_1",
          startedAt: "2026-04-29T00:00:00.000Z",
        };
      },
      async cancelSearch() {},
      onEvent() {
        return disposable;
      },
    },
    nexusGit: {
      async invoke() {
        throw new Error("Git bridge invoke was not expected in useAppServices return-shape test.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusFileActions: {
      async invoke() {
        throw new Error("File action invoke was not expected in useAppServices return-shape test.");
      },
      async startFileDrag() {
        return { type: "file-actions/start-file-drag/result", ok: true };
      },
      getPathForFile() {
        return "/tmp/file.txt";
      },
    },
  } as unknown as Window & typeof globalThis;
}
