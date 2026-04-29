import type {
  EditorBridgeRequest,
  EditorBridgeResultFor,
  LspDiagnostic,
  LspLanguage,
  LspStatus,
  LspTextEdit,
  WorkspaceFileKind,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { TerminalTabId } from "../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type CenterWorkbenchMode = "split" | "editor-max" | "terminal-max";
export type CenterWorkbenchPane = "editor" | "terminal";
export type EditorPaneId = string;
export type EditorTabId = string;
export type EditorTabKind = "file" | "diff";
export type ExternalEditorDropCardinalEdge = "top" | "right" | "bottom" | "left";
export type ExternalEditorDropCornerEdge = "top-left" | "top-right" | "bottom-right" | "bottom-left";
export type ExternalEditorDropEdge = ExternalEditorDropCardinalEdge | ExternalEditorDropCornerEdge | "center";
export type TerminalTabDragSource = "bottom-panel" | "editor-group";

export interface ExternalEditorWorkspaceFileDropItem {
  path: string;
  kind: WorkspaceFileKind;
}

export type ExternalEditorDropPayload =
  | {
      type: "workspace-file";
      workspaceId: WorkspaceId;
      path: string;
      kind: WorkspaceFileKind;
    }
  | {
      type: "workspace-file-multi";
      workspaceId: WorkspaceId;
      items: ExternalEditorWorkspaceFileDropItem[];
    }
  | {
      type: "os-file";
      files: File[];
      resolvedPaths?: string[];
    }
  | {
      type: "terminal-tab";
      workspaceId: WorkspaceId;
      tabId: TerminalTabId;
      source?: TerminalTabDragSource;
      sourceGroupId?: EditorPaneId | null;
    };

export const CENTER_WORKBENCH_MODE_STORAGE_KEY = "nx.center.mode";
export const DEFAULT_EDITOR_PANE_ID: EditorPaneId = "p0";
export const SECONDARY_EDITOR_PANE_ID: EditorPaneId = "p1";
export const MAX_EDITOR_PANE_COUNT = 6;
export const WORKSPACE_EDIT_CLOSED_FILE_WARNING_THRESHOLD = 10;
export const WORKSPACE_EDIT_CLOSED_FILE_POLICY =
  "WorkspaceEdit text edits open closed files as dirty tabs through the editor bridge; edits are never written to disk automatically.";

export interface EditorBridge {
  invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>>;
}

export interface EditorDiffSide {
  workspaceId: WorkspaceId;
  path: string;
  title: string;
  content: string;
  language: LspLanguage | null;
  monacoLanguage: string;
}

export interface EditorDiffDescriptor {
  left: EditorDiffSide;
  right: EditorDiffSide;
  source: "compare" | "source-control" | "manual";
}

export interface OpenDiffTabSide {
  workspaceId: WorkspaceId;
  path: string;
  title?: string;
  content?: string;
  language?: LspLanguage | null;
  monacoLanguage?: string;
}

export interface OpenDiffTabOptions {
  id?: string;
  title?: string;
  source?: EditorDiffDescriptor["source"];
}

export interface EditorTab {
  kind: EditorTabKind;
  id: EditorTabId;
  workspaceId: WorkspaceId;
  path: string;
  title: string;
  content: string;
  savedContent: string;
  version: string;
  dirty: boolean;
  saving: boolean;
  errorMessage: string | null;
  language: LspLanguage | null;
  monacoLanguage: string;
  lspDocumentVersion: number;
  diagnostics: LspDiagnostic[];
  lspStatus: LspStatus | null;
  readOnly?: boolean;
  diff?: EditorDiffDescriptor;
}

export interface EditorPaneState {
  id: EditorPaneId;
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
}

export interface EditorPanesState {
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
}

export function createDefaultEditorPanesState(): EditorPanesState {
  return {
    panes: [
      {
        id: DEFAULT_EDITOR_PANE_ID,
        tabs: [],
        activeTabId: null,
      },
    ],
    activePaneId: DEFAULT_EDITOR_PANE_ID,
  };
}

export function migrateEditorPanesState(persistedState: unknown): EditorPanesState {
  const rawState = unwrapPersistedEditorState(persistedState);

  if (isRecord(rawState) && Array.isArray(rawState.panes)) {
    const panes = rawState.panes
      .slice(0, MAX_EDITOR_PANE_COUNT)
      .map((pane, index): EditorPaneState | null => {
        if (!isRecord(pane)) {
          return null;
        }
        const id = typeof pane.id === "string" && pane.id.length > 0
          ? pane.id
          : index === 0
            ? DEFAULT_EDITOR_PANE_ID
            : SECONDARY_EDITOR_PANE_ID;
        const tabs = Array.isArray(pane.tabs) ? normalizeEditorTabs(pane.tabs) : [];
        const activeTabId = normalizePaneActiveTabId(tabs, pane.activeTabId);
        return { id, tabs, activeTabId };
      })
      .filter((pane): pane is EditorPaneState => pane !== null);

    if (panes.length > 0) {
      const activePaneId =
        typeof rawState.activePaneId === "string" &&
        panes.some((pane) => pane.id === rawState.activePaneId)
          ? rawState.activePaneId
          : panes[0]!.id;
      return { panes, activePaneId };
    }
  }

  if (isRecord(rawState) && Array.isArray(rawState.tabs)) {
    const tabs = normalizeEditorTabs(rawState.tabs);
    return {
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs,
          activeTabId: normalizePaneActiveTabId(tabs, rawState.activeTabId),
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    };
  }

  return createDefaultEditorPanesState();
}

export function getActiveEditorPane(state: Pick<EditorPanesState, "panes" | "activePaneId">): EditorPaneState {
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0] ?? {
    id: DEFAULT_EDITOR_PANE_ID,
    tabs: [],
    activeTabId: null,
  };
}

export function getActiveEditorTabId(
  state: Pick<EditorPanesState, "panes" | "activePaneId">,
): EditorTabId | null {
  return getActiveEditorPane(state).activeTabId;
}

export function tabIdFor(workspaceId: WorkspaceId, path: string): EditorTabId {
  return `${workspaceId}::${path}`;
}

export function diffTabIdFor(
  workspaceId: WorkspaceId,
  left: Pick<EditorDiffSide, "workspaceId" | "path">,
  right: Pick<EditorDiffSide, "workspaceId" | "path">,
  source: EditorDiffDescriptor["source"] = "manual",
): EditorTabId {
  return [
    "diff",
    source,
    workspaceId,
    left.workspaceId,
    left.path,
    right.workspaceId,
    right.path,
  ].map(encodeDiffTabIdPart).join("::");
}

export function migrateCenterWorkbenchMode(mode: unknown): CenterWorkbenchMode {
  if (mode === "split" || mode === "editor-max" || mode === "terminal-max") {
    return mode;
  }

  if (mode === "editor") {
    return "editor-max";
  }

  if (mode === "terminal") {
    return "terminal-max";
  }

  return "split";
}

export function maximizedCenterWorkbenchModeForPane(pane: CenterWorkbenchPane): CenterWorkbenchMode {
  return pane === "editor" ? "editor-max" : "terminal-max";
}

export function toggleCenterWorkbenchMaximize(
  mode: CenterWorkbenchMode,
  pane: CenterWorkbenchPane,
): CenterWorkbenchMode {
  const maximizedMode = maximizedCenterWorkbenchModeForPane(pane);
  return mode === maximizedMode ? "split" : maximizedMode;
}

export function detectLspLanguage(filePath: string): LspLanguage | null {
  const lowerPath = filePath.toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(lowerPath)) {
    return "typescript";
  }
  if (lowerPath.endsWith(".py")) {
    return "python";
  }
  if (lowerPath.endsWith(".go")) {
    return "go";
  }
  return null;
}

export function monacoLanguageIdForPath(
  filePath: string,
  lspLanguage = detectLspLanguage(filePath),
): string {
  const lowerPath = filePath.toLowerCase();
  if (lspLanguage === "typescript") {
    return lowerPath.endsWith(".js") || lowerPath.endsWith(".jsx") ? "javascript" : "typescript";
  }
  if (lspLanguage === "python") {
    return "python";
  }
  if (lspLanguage === "go") {
    return "go";
  }
  if (lowerPath.endsWith(".json")) {
    return "json";
  }
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown")) {
    return "markdown";
  }
  if (lowerPath.endsWith(".css")) {
    return "css";
  }
  if (lowerPath.endsWith(".html")) {
    return "html";
  }
  return "plaintext";
}

export function titleForPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

export function applyLspTextEdits(content: string, edits: readonly LspTextEdit[]): string {
  const lineOffsets = computeLineOffsets(content);
  const resolvedEdits = edits.map((edit) => {
    const startOffset = offsetAt(content, lineOffsets, edit.range.start.line, edit.range.start.character);
    const endOffset = offsetAt(content, lineOffsets, edit.range.end.line, edit.range.end.character);
    if (startOffset > endOffset) {
      throw new Error("LSP text edit range start is after range end.");
    }
    return {
      startOffset,
      endOffset,
      newText: edit.newText,
    };
  });

  resolvedEdits.sort((left, right) => {
    if (left.startOffset !== right.startOffset) {
      return right.startOffset - left.startOffset;
    }
    return right.endOffset - left.endOffset;
  });

  let nextContent = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of resolvedEdits) {
    if (edit.endOffset > previousStart) {
      throw new Error("Overlapping LSP text edits are not supported.");
    }
    nextContent =
      nextContent.slice(0, edit.startOffset) +
      edit.newText +
      nextContent.slice(edit.endOffset);
    previousStart = edit.startOffset;
  }

  return nextContent;
}

function encodeDiffTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

function computeLineOffsets(content: string): number[] {
  const lineOffsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lineOffsets.push(index + 1);
    }
  }
  return lineOffsets;
}

function offsetAt(
  content: string,
  lineOffsets: readonly number[],
  line: number,
  character: number,
): number {
  const lineIndex = Math.max(0, Math.min(Math.trunc(line), lineOffsets.length - 1));
  const lineStart = lineOffsets[lineIndex] ?? 0;
  const nextLineStart = lineOffsets[lineIndex + 1] ?? content.length + 1;
  const lineEnd = Math.max(lineStart, Math.min(nextLineStart - 1, content.length));
  return Math.max(lineStart, Math.min(lineStart + Math.max(0, Math.trunc(character)), lineEnd));
}

function unwrapPersistedEditorState(persistedState: unknown): unknown {
  if (
    isRecord(persistedState) &&
    isRecord(persistedState.state) &&
    ("panes" in persistedState.state || "tabs" in persistedState.state)
  ) {
    return persistedState.state;
  }

  return persistedState;
}

function normalizeEditorTabs(tabs: unknown[]): EditorTab[] {
  return tabs
    .map((tab) => normalizeEditorTab(tab))
    .filter((tab): tab is EditorTab => tab !== null);
}

function normalizeEditorTab(tab: unknown): EditorTab | null {
  if (!isRecord(tab)) {
    return null;
  }

  const normalizedKind: EditorTabKind = tab.kind === "diff" ? "diff" : "file";
  const normalizedWorkspaceId = typeof tab.workspaceId === "string" ? tab.workspaceId as WorkspaceId : null;
  const normalizedPath = typeof tab.path === "string" ? tab.path : null;
  const normalizedId = typeof tab.id === "string"
    ? tab.id
    : normalizedWorkspaceId && normalizedPath
      ? tabIdFor(normalizedWorkspaceId, normalizedPath)
      : null;

  if (!normalizedId || !normalizedWorkspaceId || !normalizedPath) {
    return null;
  }

  const language = typeof tab.language === "string" ? tab.language as LspLanguage : detectLspLanguage(normalizedPath);
  const normalizedTab: EditorTab = {
    kind: normalizedKind,
    id: normalizedId,
    workspaceId: normalizedWorkspaceId,
    path: normalizedPath,
    title: typeof tab.title === "string" ? tab.title : titleForPath(normalizedPath),
    content: typeof tab.content === "string" ? tab.content : "",
    savedContent: typeof tab.savedContent === "string" ? tab.savedContent : "",
    version: typeof tab.version === "string" ? tab.version : "",
    dirty: Boolean(tab.dirty),
    saving: Boolean(tab.saving),
    errorMessage: typeof tab.errorMessage === "string" ? tab.errorMessage : null,
    language,
    monacoLanguage: typeof tab.monacoLanguage === "string"
      ? tab.monacoLanguage
      : monacoLanguageIdForPath(normalizedPath, language),
    lspDocumentVersion: typeof tab.lspDocumentVersion === "number" ? tab.lspDocumentVersion : 1,
    diagnostics: Array.isArray(tab.diagnostics) ? tab.diagnostics as LspDiagnostic[] : [],
    lspStatus: null,
    readOnly: Boolean(tab.readOnly),
    diff: isRecord(tab.diff) ? tab.diff as unknown as EditorDiffDescriptor : undefined,
  };

  if (normalizedKind === "diff") {
    return normalizedTab.diff ? normalizedTab : null;
  }

  return normalizedTab;
}

function normalizePaneActiveTabId(
  tabs: readonly EditorTab[],
  activeTabId: unknown,
): EditorTabId | null {
  if (typeof activeTabId === "string" && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  return tabs[0]?.id ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
