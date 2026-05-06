import { useMonaco } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { provideWorkspaceSymbols } from "../../../services/editor/lsp-bridge";
import { registerWorkspaceSymbolProvider } from "../../../services/lsp/workspace-symbol-registry";
import { useActiveStore } from "../../../state/stores/active";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { CommandPalette } from "./command-palette";
import {
  closeWorkspaceSymbolPalette,
  isWorkspaceSymbolPaletteOpen,
  subscribeWorkspaceSymbolPalette,
} from "./workspace-symbol-palette-state";
import { createWorkspaceSymbolPaletteSource } from "./workspace-symbol-source";

export function WorkspaceSymbolPaletteRoot(): React.JSX.Element {
  const monaco = useMonaco();
  const activeWorkspaceId = useActiveStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [open, setOpen] = useState(isWorkspaceSymbolPaletteOpen);

  useEffect(
    () => subscribeWorkspaceSymbolPalette(() => setOpen(isWorkspaceSymbolPaletteOpen())),
    [],
  );

  useEffect(() => {
    if (!monaco) return;
    return registerWorkspaceSymbolProvider({
      id: "lsp",
      provideWorkspaceSymbols: ({ workspaceId, query, signal }) =>
        provideWorkspaceSymbols(monaco, workspaceId, query, signal),
    });
  }, [monaco]);

  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    : undefined;

  const source = useMemo(() => {
    if (!activeWorkspaceId || !activeWorkspace) return null;
    return createWorkspaceSymbolPaletteSource({
      workspaceId: activeWorkspaceId,
      workspaceRoot: activeWorkspace.rootPath,
    });
  }, [activeWorkspaceId, activeWorkspace]);

  return <CommandPalette open={open} source={source} onClose={closeWorkspaceSymbolPalette} />;
}
