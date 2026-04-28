import type { ReactElement, ReactNode } from "react";

import type {
  EditorBridgeRequest,
  EditorBridgeResultFor,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { tabIdFor, type EditorBridge, type EditorTab } from "../../../src/renderer/stores/editor-store";
import { createWorkspaceStore, type WorkspaceStore } from "../../../src/renderer/stores/workspace-store";

import { stableNow } from "./stability-common";

export const shortcutCases = [
  { key: "W", keyCode: 87 },
  { key: "B", keyCode: 66 },
  { key: "1", keyCode: 49 },
  { key: "2", keyCode: 50 },
  { key: "3", keyCode: 51 },
  { key: "M", keyCode: 77 },
  { key: "\\", keyCode: 220 },
  { key: "ArrowLeft", keyCode: 37 },
  { key: "ArrowRight", keyCode: 39 },
];

export function createTab(pathName: string, overrides: Partial<EditorTab> = {}): EditorTab {
  const workspaceId = "ws_alpha" as WorkspaceId;
  return {
    id: tabIdFor(workspaceId, pathName),
    workspaceId,
    path: pathName,
    title: pathName.split("/").at(-1) ?? pathName,
    content: "const value = 1;\n",
    savedContent: "const value = 1;\n",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
    ...overrides,
  };
}

export function createFakeEditorBridge(): EditorBridge {
  return {
    async invoke<TRequest extends EditorBridgeRequest>(request: TRequest): Promise<EditorBridgeResultFor<TRequest>> {
      switch (request.type) {
        case "lsp-document/change":
          return {
            type: "lsp-document/change/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: {
              language: request.language,
              state: "ready",
              serverName: `${request.language}-server`,
              message: null,
              updatedAt: stableNow().toISOString(),
            },
            changedAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "lsp-document/close":
          return {
            type: "lsp-document/close/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            closedAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/file/read":
          return {
            type: "workspace-files/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: "const value = 1;\n",
            encoding: "utf8",
            version: "v1",
            readAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/file/write":
          return {
            type: "workspace-files/file/write/result",
            workspaceId: request.workspaceId,
            path: request.path,
            version: "v2",
            writtenAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/tree/read":
          return {
            type: "workspace-files/tree/read/result",
            workspaceId: request.workspaceId,
            rootPath: "/tmp/ws_alpha",
            nodes: [],
            readAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        default:
          throw new Error(`Unhandled fake editor bridge request: ${request.type}`);
      }
    },
  };
}

export function createFakeWorkspaceStore(initial: WorkspaceSidebarState): WorkspaceStore {
  let sidebarState = initial;
  const store = createWorkspaceStore({
    async getSidebarState() {
      return sidebarState;
    },
    async openFolder() {
      return sidebarState;
    },
    async activateWorkspace(workspaceId) {
      sidebarState = { ...sidebarState, activeWorkspaceId: workspaceId };
      return sidebarState;
    },
    async closeWorkspace(workspaceId) {
      sidebarState = {
        openWorkspaces: sidebarState.openWorkspaces.filter((workspace) => workspace.id !== workspaceId),
        activeWorkspaceId: sidebarState.openWorkspaces.find((workspace) => workspace.id !== workspaceId)?.id ?? null,
      };
      return sidebarState;
    },
  });
  store.setState({ sidebarState });
  return store;
}

export function findElementByPredicate(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | undefined {
  return findElementsByPredicate(node, predicate)[0];
}

export function findElementsByPredicate(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return [...matches, ...findElementsByPredicate(node.type(node.props), predicate)];
    }
    return [...matches, ...findElementsByPredicate(node.props.children, predicate)];
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

export function findText(node: ReactNode, text: string): boolean {
  if (typeof node === "string" || typeof node === "number") {
    return String(node) === text;
  }
  if (isReactElement(node)) {
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return findText(node.type(node.props), text);
    }
    return findText(node.props.children, text);
  }
  if (Array.isArray(node)) {
    return node.some((child) => findText(child, text));
  }
  return false;
}

export function hasTextChild(element: ReactElement, text: string): boolean {
  return textContent(element) === text;
}

export function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (isReactElement(node)) {
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return textContent(node.type(node.props));
    }
    return textContent(node.props.children);
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }
  return "";
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
