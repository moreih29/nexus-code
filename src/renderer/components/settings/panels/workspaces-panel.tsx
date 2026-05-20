// src/renderer/components/settings/panels/workspaces-panel.tsx
//
// Two-column layout:
//   Left (240px): scrollable workspace list — click to select.
//   Right (flex-1): detail for the selected workspace.
//     - "Language Servers" section with one Switch per supported language.
//     - Switch toggles call lsp.setEnabledLanguages IPC + optimistic store update.
//
// Empty state: when the user has no workspaces yet, a centered CTA replaces
// both columns.

import { Folder, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import type { LspLanguageId } from "../../../../shared/types/app-state";
import { ipcCallResult } from "../../../ipc/client";
import { useLspEnabledStore } from "../../../state/stores/lsp-enabled";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { PythonLogo } from "../../icons/python-logo";
import { TypeScriptLogo } from "../../icons/typescript-logo";
import { Switch } from "../../ui/switch";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_LIST_WIDTH_PX = 240;

/** Ordered list of languages that can be toggled. */
const LANGUAGE_ITEMS: {
  id: LspLanguageId;
  label: string;
  Logo: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "typescript", label: "TypeScript", Logo: TypeScriptLogo },
  { id: "python", label: "Python", Logo: PythonLogo },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspacesPanelProps {
  /** Pre-select this workspace when the panel mounts. */
  initialWorkspaceId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspacesPanel({ initialWorkspaceId }: WorkspacesPanelProps) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  // Compute initial selected id once: prefer initialWorkspaceId if valid,
  // fall back to first workspace, null when empty.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (workspaces.length === 0) return null;
    if (initialWorkspaceId && workspaces.some((w) => w.id === initialWorkspaceId)) {
      return initialWorkspaceId;
    }
    return workspaces[0]?.id ?? null;
  });

  // Keep a ref to the latest selectedId so the workspaces effect can read it
  // without taking it as a dep (which would cause an infinite loop).
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // When the workspace list changes (workspace added or removed), prune a
  // stale selection by falling back to the first workspace or null.
  useEffect(() => {
    if (workspaces.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedIdRef.current || !workspaces.some((w) => w.id === selectedIdRef.current)) {
      setSelectedId(workspaces[0]?.id ?? null);
    }
  }, [workspaces]);

  // Empty state
  if (workspaces.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-center">
        <p className="text-app-ui-sm text-muted-foreground">
          Add a workspace from the sidebar to get started.
        </p>
      </div>
    );
  }

  const selectedWorkspace = workspaces.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 h-full">
      {/* Left: workspace list */}
      <div
        className="shrink-0 flex flex-col border-r border-border overflow-y-auto app-scrollbar pr-1"
        style={{ width: WORKSPACE_LIST_WIDTH_PX }}
      >
        {workspaces.map((ws) => {
          const isSelected = ws.id === selectedId;
          const isSsh = ws.location.kind === "ssh";
          const Icon = isSsh ? Server : Folder;

          return (
            <button
              key={ws.id}
              type="button"
              onClick={() => setSelectedId(ws.id)}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-2 rounded-(--radius-control)",
                "text-left text-app-body font-sans cursor-pointer select-none transition-colors",
                "border-l-2",
                isSelected
                  ? "border-l-[var(--state-selected-indicator)] bg-[var(--state-selected-bg)] text-[var(--state-selected-fg)]"
                  : "border-l-transparent text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{ws.name}</span>
            </button>
          );
        })}
      </div>

      {/* Right: detail */}
      <div className="flex flex-1 flex-col min-w-0 pl-6">
        {selectedWorkspace ? (
          <WorkspaceDetail workspaceId={selectedWorkspace.id} />
        ) : (
          <div className="flex items-center justify-center py-8 text-app-ui-sm text-muted-foreground">
            Select a workspace.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  // Subscribe to the store so the switches re-render on external changes
  // (e.g. sidebar chip toggle which broadcasts enabledLanguagesChanged).
  const enabledLanguages = useLspEnabledStore((s) => s.byWorkspace[workspaceId] ?? []);

  function handleToggle(languageId: LspLanguageId, newChecked: boolean) {
    const current = useLspEnabledStore.getState().byWorkspace[workspaceId] ?? [];
    const next = newChecked ? [...current, languageId] : current.filter((l) => l !== languageId);

    // Optimistic update.
    useLspEnabledStore.getState().setForWorkspace(workspaceId, next);

    // Persist to main — fire-and-forget; main broadcasts enabledLanguagesChanged
    // which re-confirms the store state via the bridge listener.
    void ipcCallResult("lsp", "setEnabledLanguages", { workspaceId, languages: next });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Language Servers section */}
      <section>
        <h2 className="text-app-ui-sm text-muted-foreground mb-1">Language Servers</h2>
        <p className="text-app-micro text-muted-foreground mb-4">
          Enable the language servers you want to run for this workspace. Disabled servers free up
          memory.
        </p>

        <div className="flex flex-col gap-3">
          {LANGUAGE_ITEMS.map(({ id, label, Logo }) => {
            const checked = enabledLanguages.includes(id);
            return (
              <div key={id} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <Logo className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-app-body text-foreground">{label}</span>
                </div>
                <Switch
                  checked={checked}
                  onCheckedChange={(v) => handleToggle(id, v)}
                  aria-label={`${checked ? "Disable" : "Enable"} ${label} language server`}
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* mt-8 spacer — reserved for future detail sections */}
    </div>
  );
}
