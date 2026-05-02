import { useCallback, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TabContent } from "./components/TabContent";
import { injectTokens } from "./design/tokens";
import { ipcCall } from "./ipc/client";
import { useActiveStore } from "./store/active";
import { useTabsStore } from "./store/tabs";
import { useWorkspacesStore } from "./store/workspaces";

injectTokens();

export function App() {
  const { workspaces, setAll } = useWorkspacesStore();
  const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useTabsStore();
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveStore();

  // Boot: load workspaces from main, activate first, seed default PTY tab
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once effect; store setters are stable
  useEffect(() => {
    ipcCall("workspace", "list", undefined).then((list) => {
      setAll(list);
      if (list.length > 0) {
        const first = list[0];
        setActiveWorkspaceId(first.id);
        ipcCall("workspace", "activate", { id: first.id }).catch(() => {});

        // Seed one default PTY tab if no tabs exist yet
        if (useTabsStore.getState().tabs.length === 0) {
          addTab("terminal", { cwd: first.rootPath });
        }
      }
    });
  }, []);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      setActiveWorkspaceId(id);
      ipcCall("workspace", "activate", { id }).catch(() => {});
    },
    [setActiveWorkspaceId],
  );

  const handleNewTerminalTab = useCallback(() => {
    const cwd = activeWorkspace?.rootPath ?? "/";
    addTab("terminal", { cwd });
  }, [activeWorkspace, addTab]);

  // Cmd+E: open file picker and add an EditorView tab
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        ipcCall("dialog", "showOpenFile", {
          title: "Open File",
          filters: [
            { name: "TypeScript / JavaScript", extensions: ["ts", "tsx", "js", "jsx"] },
            { name: "All Files", extensions: ["*"] },
          ],
        })
          .then(({ canceled, filePaths }) => {
            if (canceled || filePaths.length === 0) return;
            addTab("editor", { filePath: filePaths[0], workspaceId: wsId });
          })
          .catch(() => {});
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="app-root">
      <Sidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
      />
      <div className="app-main">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTab}
          onCloseTab={closeTab}
          onNewTerminalTab={handleNewTerminalTab}
        />
        <TabContent tab={activeTab} />
      </div>
    </div>
  );
}
