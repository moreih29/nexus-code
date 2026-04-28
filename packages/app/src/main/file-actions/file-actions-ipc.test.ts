import { describe, expect, test } from "bun:test";

import type { TerminalOpenCommand } from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { WorkspaceId, WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";
import { invokeFileActionRequest } from "./file-actions-ipc";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("file-actions IPC request dispatch", () => {
  test("reveals, opens with system app, copies paths, and opens terminals through the existing terminal bridge", async () => {
    const shellCalls: string[] = [];
    const copied: string[] = [];
    const terminalCommands: TerminalOpenCommand[] = [];
    const dragItems: Array<{ file: string; files?: string[]; icon: unknown }> = [];
    const registryStore = createRegistryStore("/tmp/alpha");

    const revealResult = await invokeFileActionRequest({
      request: {
        type: "file-actions/reveal-in-finder",
        workspaceId,
        path: "src/index.ts",
      },
      workspaceRegistryStore: registryStore,
      shell: {
        showItemInFolder(path) {
          shellCalls.push(`reveal:${path}`);
        },
        async openPath(path) {
          shellCalls.push(`open:${path}`);
          return "";
        },
      },
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      terminalOpener: {
        async openTerminal(command) {
          terminalCommands.push(command);
          return {
            type: "terminal/opened",
            tabId: "tt_ws_alpha_0000test" as never,
            workspaceId: command.workspaceId,
            pid: 123,
          };
        },
      },
    });

    await invokeFileActionRequest({
      request: {
        type: "file-actions/open-with-system-app",
        workspaceId,
        path: "src/index.ts",
      },
      workspaceRegistryStore: registryStore,
      shell: {
        showItemInFolder(path) {
          shellCalls.push(`reveal:${path}`);
        },
        async openPath(path) {
          shellCalls.push(`open:${path}`);
          return "";
        },
      },
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
    });

    await invokeFileActionRequest({
      request: {
        type: "file-actions/copy-path",
        workspaceId,
        path: "src/index.ts",
        pathKind: "relative",
      },
      workspaceRegistryStore: registryStore,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
    });

    const terminalResult = await invokeFileActionRequest({
      request: {
        type: "file-actions/open-in-terminal",
        workspaceId,
        path: "src/index.ts",
        kind: "file",
      },
      workspaceRegistryStore: registryStore,
      terminalOpener: {
        async openTerminal(command) {
          terminalCommands.push(command);
          return {
            type: "terminal/opened",
            tabId: "tt_ws_alpha_0001test" as never,
            workspaceId: command.workspaceId,
            pid: 456,
          };
        },
      },
    });

    const dragResult = await invokeFileActionRequest({
      request: {
        type: "file-actions/start-file-drag",
        workspaceId,
        paths: ["src/index.ts"],
      },
      workspaceRegistryStore: registryStore,
      dragStarter: {
        startDrag(item) {
          dragItems.push(item);
        },
      },
      dragIcon: "drag-icon.png",
    });

    expect(revealResult).toMatchObject({ action: "revealInFinder", absolutePath: "/tmp/alpha/src/index.ts" });
    expect(terminalResult.type).toBe("file-actions/shell/result");
    expect(dragResult).toMatchObject({
      type: "file-actions/start-file-drag/result",
      workspaceId,
      paths: ["src/index.ts"],
      absolutePaths: ["/tmp/alpha/src/index.ts"],
    });
    expect(dragItems).toEqual([
      {
        file: "/tmp/alpha/src/index.ts",
        files: ["/tmp/alpha/src/index.ts"],
        icon: "drag-icon.png",
      },
    ]);
    expect(shellCalls).toEqual([
      "reveal:/tmp/alpha/src/index.ts",
      "open:/tmp/alpha/src/index.ts",
    ]);
    expect(copied).toEqual(["src/index.ts"]);
    expect(terminalCommands[0]).toMatchObject({
      type: "terminal/open",
      workspaceId,
      cwd: "/tmp/alpha/src",
      cols: 120,
      rows: 30,
    });
  });

  test("opens terminals at directory and workspace roots without launching a real terminal", async () => {
    const terminalCommands: TerminalOpenCommand[] = [];
    const registryStore = createRegistryStore("/tmp/alpha");
    const terminalOpener = {
      async openTerminal(command: TerminalOpenCommand) {
        terminalCommands.push(command);
        return {
          type: "terminal/opened" as const,
          tabId: "tt_ws_alpha_terminal" as never,
          workspaceId: command.workspaceId,
          pid: 789,
        };
      },
    };

    await invokeFileActionRequest({
      request: {
        type: "file-actions/open-in-terminal",
        workspaceId,
        path: "src",
        kind: "directory",
      },
      workspaceRegistryStore: registryStore,
      terminalOpener,
    });
    await invokeFileActionRequest({
      request: {
        type: "file-actions/open-in-terminal",
        workspaceId,
        path: null,
        kind: "workspace",
      },
      workspaceRegistryStore: registryStore,
      terminalOpener,
    });

    expect(terminalCommands.map((command) => command.cwd)).toEqual([
      "/tmp/alpha/src",
      "/tmp/alpha",
    ]);
  });

  test("surfaces OS openPath failures from the mocked shell", async () => {
    await expect(invokeFileActionRequest({
      request: {
        type: "file-actions/open-with-system-app",
        workspaceId,
        path: "src/index.ts",
      },
      workspaceRegistryStore: createRegistryStore("/tmp/alpha"),
      shell: {
        showItemInFolder() {},
        async openPath() {
          return "No associated application";
        },
      },
    })).rejects.toThrow("No associated application");
  });

  test("smoke-verifies drag-out of 5 files through mocked webContents.startDrag", async () => {
    const dragItems: Array<{ file: string; files?: string[]; icon: unknown }> = [];
    const paths = Array.from({ length: 5 }, (_, index) => `src/drag-out-${index}.ts`);
    const result = await invokeFileActionRequest({
      request: {
        type: "file-actions/start-file-drag",
        workspaceId,
        paths,
      },
      workspaceRegistryStore: createRegistryStore("/tmp/alpha"),
      dragStarter: {
        startDrag(item) {
          dragItems.push(item);
        },
      },
      dragIcon: "drag-icon.png",
    });

    expect(result).toMatchObject({
      type: "file-actions/start-file-drag/result",
      workspaceId,
      paths,
      absolutePaths: paths.map((relativePath) => `/tmp/alpha/${relativePath}`),
    });
    expect(dragItems).toEqual([
      {
        file: "/tmp/alpha/src/drag-out-0.ts",
        files: paths.map((relativePath) => `/tmp/alpha/${relativePath}`),
        icon: "drag-icon.png",
      },
    ]);
  });
});

function createRegistryStore(root: string) {
  const registry: WorkspaceRegistry = {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        absolutePath: root,
        displayName: "Alpha",
        createdAt: "2026-04-28T00:00:00.000Z",
        lastOpenedAt: "2026-04-28T00:00:00.000Z",
      },
    ],
  };

  return {
    async getWorkspaceRegistry() {
      return registry;
    },
  };
}
