import { useEffect } from "react";
import { COMMANDS } from "../../shared/commands";
import { registerCommand } from "../commands/registry";
import { Grid } from "../engine/split";
import { ipcCall } from "../ipc/client";
import {
  closeEditor,
  closeEditorWithConfirm,
  filePathToModelUri,
  isDirty,
  openOrRevealEditor,
  saveModel,
} from "../services/editor";
import { createPathActions } from "../services/fs-mutations";
import { closeTerminal, openTerminal } from "../services/terminal";
import { closeGroup } from "../state/operations";
import { useActiveStore } from "../state/stores/active";
import { useFilesStore } from "../state/stores/files";
import { useLayoutStore } from "../state/stores/layout";
import { type EditorTabProps, type TerminalTabProps, useTabsStore } from "../state/stores/tabs";
import { useWorkspacesStore } from "../state/stores/workspaces";
import { handleGlobalKeyDown } from "./dispatcher";

/**
 * Resolve the active group's currently focused tab. Returns null if any
 * link in the chain is missing (no workspace, no layout, empty group).
 * Each handler call re-resolves through the live stores so the result
 * tracks user navigation without rewiring the global listener.
 */
function getActiveTabContext():
  | { wsId: string; leaf: { id: string; tabIds: string[] }; tabId: string }
  | null {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return null;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return null;
  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!activeLeaf?.activeTabId) return null;
  return { wsId, leaf: activeLeaf, tabId: activeLeaf.activeTabId };
}

function getWorkspaceRootPath(workspaceId: string): string | null {
  return (
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null
  );
}

/**
 * Build the path-action trio anchored to the currently active editor.
 * Returns null when there is no active editor (or no workspace), so the
 * caller can no-op without each shortcut handler re-walking the chain.
 */
function getActiveEditorPathActions() {
  const ctx = getActiveTabContext();
  if (!ctx) return null;
  const root = getWorkspaceRootPath(ctx.wsId);
  if (!root) return null;
  return createPathActions({
    workspaceId: ctx.wsId,
    workspaceRootPath: root,
    getAbsPath: () => {
      const cur = useTabsStore.getState().byWorkspace[ctx.wsId]?.[ctx.tabId];
      if (!cur || cur.type !== "editor") return null;
      return (cur.props as EditorTabProps).filePath;
    },
  });
}

async function closeTabById(workspaceId: string, tabId: string): Promise<"closed" | "cancelled"> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) return "closed";
  if (tab.type === "terminal") {
    closeTerminal(tabId);
    return "closed";
  }
  if (tab.type === "editor") {
    const outcome = await closeEditorWithConfirm(workspaceId, tabId);
    return outcome === "cancelled" ? "cancelled" : "closed";
  }
  return "closed";
}

/**
 * Register every command implementation and wire the global keydown
 * listener. Both surfaces (keyboard and Application Menu) execute
 * commands through the registry, so the implementations live in one
 * place. Mounted once at the app root for the entire app lifetime.
 */
export function useGlobalKeybindings(): void {
  useEffect(() => {
    const unregister: Array<() => void> = [];

    unregister.push(
      registerCommand(COMMANDS.filesRefresh, () => {
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        useFilesStore
          .getState()
          .refresh(wsId)
          .catch(() => {});
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.openToSide, () => {
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        const path = useFilesStore.getState().activeAbsPath.get(wsId);
        if (!path) return;
        // Mirror the file-tree's local "open in side split" — the
        // explorer publishes the active row's absPath to the store so
        // this handler can act without seeing the tree's component
        // state. Directories are filtered here (not in the file-tree)
        // because the global dispatcher fires regardless of the row's
        // node type.
        const tree = useFilesStore.getState().trees.get(wsId);
        const node = tree?.nodes.get(path);
        if (!node || node.type !== "file") return;
        openOrRevealEditor(
          { workspaceId: wsId, filePath: path },
          { newSplit: { orientation: "horizontal", side: "after" } },
        );
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.fileOpen, async () => {
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        const { canceled, filePaths } = await ipcCall("dialog", "showOpenFile", {
          title: "Open File",
          filters: [
            { name: "TypeScript / JavaScript", extensions: ["ts", "tsx", "js", "jsx"] },
            { name: "All Files", extensions: ["*"] },
          ],
        });
        if (canceled || filePaths.length === 0) return;
        openOrRevealEditor({ workspaceId: wsId, filePath: filePaths[0] });
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.fileSave, () => {
        const ctx = getActiveTabContext();
        if (!ctx) return;
        const tab = useTabsStore.getState().byWorkspace[ctx.wsId]?.[ctx.tabId];
        if (!tab || tab.type !== "editor") return;
        const props = tab.props as EditorTabProps;
        saveModel({ workspaceId: ctx.wsId, filePath: props.filePath }).catch(() => {});
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.tabClose, () => {
        const ctx = getActiveTabContext();
        if (!ctx) return;
        void closeTabById(ctx.wsId, ctx.tabId);
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.tabCloseOthers, async () => {
        const ctx = getActiveTabContext();
        if (!ctx) return;
        // Pin protection mirrors `useGroupActions.closeOthers`.
        const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
        const others = ctx.leaf.tabIds.filter(
          (id) => id !== ctx.tabId && !wsRecord[id]?.isPinned,
        );
        for (const id of others) {
          const outcome = await closeTabById(ctx.wsId, id);
          if (outcome === "cancelled") return;
        }
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.tabCloseSaved, () => {
        // Close every editor tab in the active group whose buffer is
        // clean. No confirms — saved-clean tabs by definition have no
        // unsaved work. Mirrors `useGroupActions.closeSaved`.
        const ctx = getActiveTabContext();
        if (!ctx) return;
        const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
        for (const id of ctx.leaf.tabIds) {
          const tab = wsRecord[id];
          if (tab?.type !== "editor") continue;
          const filePath = (tab.props as EditorTabProps).filePath;
          if (isDirty(filePathToModelUri(filePath))) continue;
          closeEditor(id);
        }
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.tabCloseAll, async () => {
        // VSCode "Close All Editors": closes pinned tabs too — pin only
        // protects against bulk Close Others / Close-to-Right gestures.
        const ctx = getActiveTabContext();
        if (!ctx) return;
        for (const id of [...ctx.leaf.tabIds]) {
          const outcome = await closeTabById(ctx.wsId, id);
          if (outcome === "cancelled") return;
        }
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.tabPinToggle, () => {
        const ctx = getActiveTabContext();
        if (!ctx) return;
        useTabsStore.getState().togglePin(ctx.wsId, ctx.tabId);
      }),
    );

    unregister.push(
      registerCommand(COMMANDS.groupSplitRight, () => splitActiveGroup("horizontal")),
    );
    unregister.push(
      registerCommand(COMMANDS.groupSplitDown, () => splitActiveGroup("vertical")),
    );

    unregister.push(
      registerCommand(COMMANDS.groupClose, () => {
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        const layout = useLayoutStore.getState().byWorkspace[wsId];
        if (!layout) return;
        closeGroup(wsId, layout.activeGroupId);
      }),
    );

    unregister.push(registerCommand(COMMANDS.groupFocusLeft, () => moveFocus("left")));
    unregister.push(registerCommand(COMMANDS.groupFocusRight, () => moveFocus("right")));
    unregister.push(registerCommand(COMMANDS.groupFocusUp, () => moveFocus("up")));
    unregister.push(registerCommand(COMMANDS.groupFocusDown, () => moveFocus("down")));

    unregister.push(
      registerCommand(COMMANDS.pathReveal, () => {
        getActiveEditorPathActions()?.revealInFinder();
      }),
    );
    unregister.push(
      registerCommand(COMMANDS.pathCopy, () => {
        getActiveEditorPathActions()?.copyPath();
      }),
    );
    unregister.push(
      registerCommand(COMMANDS.pathCopyRelative, () => {
        getActiveEditorPathActions()?.copyRelativePath();
      }),
    );

    // Capture phase puts our handler ahead of Monaco's standalone
    // keybinding service (which sits on the editor container in the
    // bubble phase). Without capture, ⌘K keystrokes typed inside
    // Monaco never reach our chord pipeline because Monaco's
    // dispatcher consumes them for its own ⌘K-led shortcuts.
    function onKeyDown(e: KeyboardEvent) {
      if (handleGlobalKeyDown(e)) {
        // We claimed the event — stop propagation so Monaco / xterm
        // don't re-process the same key. (Cocoa menu accelerators are
        // a separate path and can still fire; that's intentional and
        // benign for our currently-bound commands.)
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      for (const off of unregister) off();
    };
  }, []);
}

function splitActiveGroup(orientation: "horizontal" | "vertical"): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return;
  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!activeLeaf?.activeTabId) return;
  const tab = useTabsStore.getState().byWorkspace[wsId]?.[activeLeaf.activeTabId];
  if (!tab) return;

  if (tab.type === "editor") {
    openOrRevealEditor(tab.props as EditorTabProps, {
      newSplit: { orientation, side: "after" },
    });
    return;
  }
  if (tab.type === "terminal") {
    const props = tab.props as TerminalTabProps;
    openTerminal(
      { workspaceId: wsId, cwd: props.cwd },
      { groupId: activeLeaf.id, newSplit: { orientation, side: "after" } },
    );
  }
}

function moveFocus(direction: "left" | "right" | "up" | "down"): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return;
  const leaves = Grid.allLeaves(layout.root);
  if (leaves.length <= 1) return;
  const currentIdx = leaves.findIndex((l) => l.id === layout.activeGroupId);
  if (currentIdx === -1) return;
  const nextIdx =
    direction === "left" || direction === "up"
      ? currentIdx > 0
        ? currentIdx - 1
        : leaves.length - 1
      : currentIdx < leaves.length - 1
        ? currentIdx + 1
        : 0;
  const nextLeaf = leaves[nextIdx];
  if (nextLeaf) {
    useLayoutStore.getState().setActiveGroup(wsId, nextLeaf.id);
  }
}
