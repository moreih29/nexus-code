import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { createWorkspaceStore, type WorkspaceStore } from "./stores/workspace-store";

const ACTIVITY_ITEMS = ["Workspaces", "Search", "Git"] as const;

export default function App(): JSX.Element {
  const workspaceStore = useWorkspaceStore();

  const sidebarState = useStore(workspaceStore, (state) => state.sidebarState);
  const refreshSidebarState = useStore(workspaceStore, (state) => state.refreshSidebarState);
  const applySidebarState = useStore(workspaceStore, (state) => state.applySidebarState);
  const openFolder = useStore(workspaceStore, (state) => state.openFolder);
  const activateWorkspace = useStore(workspaceStore, (state) => state.activateWorkspace);
  const closeWorkspace = useStore(workspaceStore, (state) => state.closeWorkspace);

  useEffect(() => {
    void refreshSidebarState().catch((error) => {
      console.error("Workspace sidebar: failed to load sidebar state.", error);
    });
  }, [refreshSidebarState]);

  useEffect(() => {
    const subscription = window.nexusWorkspace.onSidebarStateChanged((nextState) => {
      applySidebarState(nextState);
    });

    return () => {
      subscription.dispose();
    };
  }, [applySidebarState]);

  return (
    <div className="h-full bg-slate-950 text-slate-100">
      <div className="grid h-full grid-cols-[4rem_18rem_minmax(0,1fr)_20rem]">
        <aside className="border-r border-slate-800 bg-slate-900/80 p-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Activity</p>
          <div className="mt-3 flex flex-col gap-2">
            {ACTIVITY_ITEMS.map((item, index) => (
              <Button
                key={item}
                className="w-full text-[10px] font-semibold uppercase tracking-wide"
                size="icon"
                variant={index === 0 ? "secondary" : "ghost"}
                aria-label={item}
              >
                {item.slice(0, 2)}
              </Button>
            ))}
          </div>
        </aside>

        <aside className="flex min-h-0 flex-col gap-3 border-r border-slate-800 bg-slate-900/40 p-3">
          <WorkspaceSidebar
            sidebarState={sidebarState}
            onOpenFolder={() => runSidebarMutation(openFolder)}
            onActivateWorkspace={(workspaceId) =>
              runSidebarMutation(() => activateWorkspace(workspaceId))
            }
            onCloseWorkspace={(workspaceId) =>
              runSidebarMutation(() => closeWorkspace(workspaceId))
            }
          />

          <div className="rounded-md border border-slate-700/80 bg-slate-900/70 p-3 text-sm text-slate-300">
            File tree placeholder
          </div>
        </aside>

        <main className="flex min-h-0 flex-col border-r border-slate-800 bg-black/30 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-200">Center Terminal</h2>
          <div className="mt-3 min-h-0 flex-1 rounded-md border border-emerald-700/40 bg-slate-950/80 p-3">
            <TerminalPane sidebarState={sidebarState} />
          </div>
        </main>

        <aside className="bg-slate-900/50 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-200">Right Shared Panel</h2>
          <Tabs className="mt-3" defaultValue="tool">
            <TabsList>
              <TabsTrigger value="tool">Tool</TabsTrigger>
              <TabsTrigger value="session">Session</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="tool">Tool output placeholder</TabsContent>
            <TabsContent value="session">Session context placeholder</TabsContent>
            <TabsContent value="diff">Diff viewer placeholder</TabsContent>
            <TabsContent value="preview">Preview placeholder</TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}

function useWorkspaceStore(): WorkspaceStore {
  const workspaceStoreRef = useRef<WorkspaceStore | null>(null);

  if (!workspaceStoreRef.current) {
    workspaceStoreRef.current = createWorkspaceStore(window.nexusWorkspace);
  }

  return workspaceStoreRef.current;
}

async function runSidebarMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Workspace sidebar: failed to apply workspace mutation.", error);
  }
}
