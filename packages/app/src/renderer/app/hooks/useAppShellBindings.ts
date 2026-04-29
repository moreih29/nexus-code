import type { OpenSessionWorkspace } from "../../../../../shared/src/contracts/workspace/workspace-shell";
import { keyboardRegistryStore } from "../../stores/keyboard-registry";
import { useAppCommands, type AppCommandBindings, type UseAppCommandsInput } from "../useAppCommands";
import { useEditorBindings, type EditorBindings, type UseEditorBindingsInput } from "../useEditorBindings";
import { useExplorerBindings, type ExplorerBindings, type UseExplorerBindingsInput } from "../useExplorerBindings";
import { useResizeDrag, type ResizeDragBindings } from "../useResizeDrag";
import {
  useSourceControlBindings,
  type SourceControlBindings,
  type UseSourceControlBindingsInput,
} from "../useSourceControlBindings";
import type { AppServices } from "../wiring";

export interface UseAppShellBindingsInput {
  services: AppServices;
  activeWorkspace: OpenSessionWorkspace | null;
  openWorkspaces: readonly OpenSessionWorkspace[];
}

export interface AppShellBindings {
  editorBindings: EditorBindings;
  appCommands: AppCommandBindings;
  explorerBindings: ExplorerBindings;
  sourceControlBindings: SourceControlBindings;
  resizeBindings: ResizeDragBindings;
  keybindingRegistry: typeof keyboardRegistryStore;
}

export interface AppShellBindingHooks {
  useEditorBindings(input: UseEditorBindingsInput): EditorBindings;
  useAppCommands(input: UseAppCommandsInput): AppCommandBindings;
  useExplorerBindings(input: UseExplorerBindingsInput): ExplorerBindings;
  useSourceControlBindings(input: UseSourceControlBindingsInput): SourceControlBindings;
  useResizeDrag(input: { activityBarStore: AppServices["activityBar"] }): ResizeDragBindings;
}

const defaultBindingHooks: AppShellBindingHooks = {
  useEditorBindings,
  useAppCommands,
  useExplorerBindings,
  useSourceControlBindings,
  useResizeDrag,
};

export function useAppShellBindings(
  { services, activeWorkspace, openWorkspaces }: UseAppShellBindingsInput,
  hooks: AppShellBindingHooks = defaultBindingHooks,
): AppShellBindings {
  const editorBindings = hooks.useEditorBindings({
    activeWorkspaceId: activeWorkspace?.id ?? null,
    documentsService: services.editorDocuments,
    filesService: services.files,
    gitService: services.git,
    groupsService: services.editorGroups,
    openWorkspaces,
    workspaceService: services.editorWorkspace,
  });

  const appCommands = hooks.useAppCommands({
    activityBarStore: services.activityBar,
    bottomPanelStore: services.bottomPanel,
    editorBindings,
    editorGroupsService: services.editorGroups,
    editorWorkspaceService: services.editorWorkspace,
    searchStore: services.search,
    terminalService: services.terminal,
    workspaceStore: services.workspace,
  });

  const explorerBindings = hooks.useExplorerBindings({
    activeWorkspaceId: activeWorkspace?.id ?? null,
    documentsService: services.editorDocuments,
    fileClipboardStore: services.fileClipboard,
    filesService: services.files,
    gitService: services.git,
    groupsService: services.editorGroups,
    showTerminalPanel: appCommands.showTerminalPanel,
    workspaceService: services.editorWorkspace,
  });

  const sourceControlBindings = hooks.useSourceControlBindings({
    activeWorkspace,
    documentsService: services.editorDocuments,
    groupsService: services.editorGroups,
    sourceControlStore: services.sourceControl,
    workspaceService: services.editorWorkspace,
  });

  const resizeBindings = hooks.useResizeDrag({ activityBarStore: services.activityBar });

  return {
    editorBindings,
    appCommands,
    explorerBindings,
    sourceControlBindings,
    resizeBindings,
    keybindingRegistry: keyboardRegistryStore,
  };
}
