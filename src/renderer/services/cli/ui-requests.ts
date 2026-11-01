/**
 * The renderer's side of the nexus CLI: main asks, through cli:uiRequest,
 * for what only the renderer has — the tabs, the layout and the terminals'
 * screens — or to change it (./actions), and gets its answer through
 * cli.uiRespond.
 */

import { ipcCallResult, ipcListen } from "@/ipc/client";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { allLeaves } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import type { Tab } from "@/state/stores/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import type { CliTabInfo, CliUiOp } from "../../../shared/cli/ui";
import { getTerminalController } from "../terminal/terminal-registry";
import { actionHandlers, type CliUiHandler, UiRequestError } from "./actions";
import { layoutHandlers } from "./layout-actions";

function tabInfo(tab: Tab, groupId: string, shown: boolean): CliTabInfo {
  const base = { id: tab.id, type: tab.type, title: tab.title, groupId, shown };
  switch (tab.type) {
    case "terminal":
      return { ...base, cwd: tab.props.cwd, ...(tab.props.dead ? { dead: true } : {}) };
    case "editor":
      return { ...base, filePath: tab.props.filePath };
    case "browser": {
      const runtime = useBrowserRuntimeStore.getState().runtimes.get(tab.id);
      return { ...base, url: runtime?.currentUrl || tab.props.lastUrl };
    }
    default:
      return base;
  }
}

/** A workspace's tabs, group by group, in layout order. */
export function listTabs(workspaceId: string): CliTabInfo[] {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const records = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  if (!layout) return [];
  const tabs: CliTabInfo[] = [];
  for (const leaf of allLeaves(layout.root)) {
    for (const id of leaf.tabIds) {
      const tab = records[id];
      if (tab) tabs.push(tabInfo(tab, leaf.id, leaf.activeTabId === id));
    }
  }
  return tabs;
}

const handlers: { [K in CliUiOp]: CliUiHandler<K> } = {
  "tabs.list": async ({ workspaceId }) => ({ tabs: listTabs(workspaceId) }),
  "terminal.read": async ({ tabId, lines }) => {
    const controller = getTerminalController(tabId);
    if (!controller) {
      throw new UiRequestError(
        "that terminal has not started: its workspace has not been opened since NexusCode started",
      );
    }
    return { text: controller.readText(lines) };
  },
  ...actionHandlers,
  ...layoutHandlers,
};

let markReady: () => void = () => {};
const ready = new Promise<void>((resolve) => {
  markReady = resolve;
});

/** Lets requests through once the tabs and layouts have been restored. */
export function markCliUiReady(): void {
  markReady();
}

/**
 * Installs the cli:uiRequest listener. Requests wait until markCliUiReady,
 * since before it the stores are empty. Returns the unlisten function.
 */
export function startCliUiListener(): () => void {
  return ipcListen("cli", "uiRequest", ({ requestId, op, args }) => {
    void (async () => {
      await ready;
      const handler = handlers[op as CliUiOp] as CliUiHandler<CliUiOp> | undefined;
      try {
        if (!handler) throw new UiRequestError(`unknown request ${op}`);
        const value = await handler(args as never);
        await ipcCallResult("cli", "uiRespond", { requestId, ok: true, value });
      } catch (error) {
        await ipcCallResult("cli", "uiRespond", {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
