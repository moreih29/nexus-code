import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  SearchCancelCommand,
  SearchCompletedEvent,
  SearchFailedEvent,
  SearchOptions,
  SearchStartedReply,
  SearchStartCommand,
  SearchCanceledEvent,
} from "../../../../shared/src/contracts/generated/search-lifecycle";
import type {
  SearchResult,
  SearchResultChunkMessage,
} from "../../../../shared/src/contracts/generated/search-relay";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export const SEARCH_RESULT_LIMIT = 10_000;
export const SEARCH_HISTORY_LIMIT = 20;

export type SearchStatus = "idle" | "running" | "completed" | "failed" | "canceled";
export type SearchHistoryDirection = "previous" | "next";

export type SearchBridgeEvent =
  | SearchStartedReply
  | SearchCompletedEvent
  | SearchFailedEvent
  | SearchCanceledEvent
  | SearchResultChunkMessage;

export interface SearchBridgeDisposable {
  dispose(): void;
}

export interface SearchBridge {
  startSearch(command: SearchStartCommand): Promise<SearchStartedReply | SearchFailedEvent>;
  cancelSearch(command: SearchCancelCommand): Promise<void>;
  onEvent(listener: (event: SearchBridgeEvent) => void): SearchBridgeDisposable;
}

export interface SearchPanelOptionsState {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  includeText: string;
  excludeText: string;
  useGitIgnore: boolean;
}

export interface SearchMatch extends SearchResult {
  id: string;
  ordinal: number;
}

export interface SearchFileResultGroup {
  path: string;
  matches: SearchMatch[];
}

export interface SearchActiveMatch {
  matchId: string;
  path: string;
  lineNumber: number;
  column: number;
}

export interface SearchWorkspaceState {
  query: string;
  replaceText: string;
  replaceMode: boolean;
  advancedOpen: boolean;
  options: SearchPanelOptionsState;
  status: SearchStatus;
  errorMessage: string | null;
  activeSessionId: string | null;
  activeRequestId: string | null;
  history: string[];
  historyCursor: number | null;
  groupsByPath: Record<string, SearchFileResultGroup>;
  fileOrder: string[];
  matchCount: number;
  fileCount: number;
  truncated: boolean;
  activeMatch: SearchActiveMatch | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SearchStartInput {
  workspaceId: WorkspaceId;
  cwd: string;
  query?: string;
}

export interface SearchStoreState {
  workspaceById: Record<string, SearchWorkspaceState>;
  applyBridgeEvent(event: SearchBridgeEvent): void;
  cancelSearch(workspaceId: WorkspaceId): Promise<void>;
  cycleHistory(workspaceId: WorkspaceId, direction: SearchHistoryDirection): string | null;
  dismiss(workspaceId: WorkspaceId): void;
  getFileGroups(workspaceId: WorkspaceId): SearchFileResultGroup[];
  getWorkspaceState(workspaceId: WorkspaceId): SearchWorkspaceState;
  goToNextMatch(workspaceId: WorkspaceId): SearchMatch | null;
  selectMatch(workspaceId: WorkspaceId, match: SearchMatch): void;
  setAdvancedOpen(workspaceId: WorkspaceId, open: boolean): void;
  setExcludeText(workspaceId: WorkspaceId, value: string): void;
  setIncludeText(workspaceId: WorkspaceId, value: string): void;
  setQuery(workspaceId: WorkspaceId, query: string): void;
  setReplaceMode(workspaceId: WorkspaceId, enabled: boolean): void;
  setReplaceText(workspaceId: WorkspaceId, value: string): void;
  startBridgeSubscription(): void;
  startSearch(input: SearchStartInput): Promise<void>;
  stopBridgeSubscription(): void;
  toggleOption(workspaceId: WorkspaceId, option: "caseSensitive" | "regex" | "wholeWord"): void;
}

export type SearchStore = StoreApi<SearchStoreState>;

export const EMPTY_SEARCH_WORKSPACE_STATE: SearchWorkspaceState = createInitialWorkspaceState();

export function createSearchStore(searchBridge: SearchBridge): SearchStore {
  let subscription: SearchBridgeDisposable | null = null;
  let nextRequestSequence = 0;

  const store = createStore<SearchStoreState>((set, get) => ({
    workspaceById: {},
    applyBridgeEvent(event) {
      set((state) => applySearchBridgeEventToState(state, event));
    },
    async cancelSearch(workspaceId) {
      const workspace = get().workspaceById[workspaceId];
      if (!workspace?.activeSessionId || !workspace.activeRequestId) {
        return;
      }

      const requestId = nextSearchRequestId(++nextRequestSequence);
      await searchBridge.cancelSearch({
        type: "search/lifecycle",
        action: "cancel",
        requestId,
        workspaceId,
        sessionId: workspace.activeSessionId,
      });
    },
    cycleHistory(workspaceId, direction) {
      const workspace = get().workspaceById[workspaceId] ?? createInitialWorkspaceState();
      if (workspace.history.length === 0) {
        return null;
      }

      const nextCursor = nextHistoryCursor(workspace.history, workspace.historyCursor, direction);
      const nextQuery = workspace.history[nextCursor] ?? workspace.query;
      setWorkspaceState(set, workspaceId, (current) => ({
        ...current,
        query: nextQuery,
        historyCursor: nextCursor,
      }));
      return nextQuery;
    },
    dismiss(workspaceId) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        activeMatch: null,
        historyCursor: null,
      }));
    },
    getFileGroups(workspaceId) {
      return getSearchFileGroups(get().workspaceById[workspaceId] ?? EMPTY_SEARCH_WORKSPACE_STATE);
    },
    getWorkspaceState(workspaceId) {
      return get().workspaceById[workspaceId] ?? EMPTY_SEARCH_WORKSPACE_STATE;
    },
    goToNextMatch(workspaceId) {
      const workspace = get().workspaceById[workspaceId] ?? EMPTY_SEARCH_WORKSPACE_STATE;
      const matches = getSearchMatches(workspace);
      if (matches.length === 0) {
        return null;
      }

      const currentIndex = workspace.activeMatch
        ? matches.findIndex((match) => match.id === workspace.activeMatch?.matchId)
        : -1;
      const nextMatch = matches[(currentIndex + 1 + matches.length) % matches.length]!;
      get().selectMatch(workspaceId, nextMatch);
      return nextMatch;
    },
    selectMatch(workspaceId, match) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        activeMatch: {
          matchId: match.id,
          path: match.path,
          lineNumber: match.lineNumber,
          column: match.column,
        },
      }));
    },
    setAdvancedOpen(workspaceId, open) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        advancedOpen: open,
      }));
    },
    setExcludeText(workspaceId, value) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        options: {
          ...workspace.options,
          excludeText: value,
        },
      }));
    },
    setIncludeText(workspaceId, value) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        options: {
          ...workspace.options,
          includeText: value,
        },
      }));
    },
    setQuery(workspaceId, query) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        query,
        historyCursor: null,
      }));
    },
    setReplaceMode(workspaceId, enabled) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        replaceMode: enabled,
      }));
    },
    setReplaceText(workspaceId, value) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        replaceText: value,
      }));
    },
    startBridgeSubscription() {
      if (subscription) {
        return;
      }

      subscription = searchBridge.onEvent((event) => {
        get().applyBridgeEvent(event);
      });
    },
    async startSearch(input) {
      const currentWorkspace = get().workspaceById[input.workspaceId] ?? createInitialWorkspaceState();
      const query = (input.query ?? currentWorkspace.query).trim();
      if (!query) {
        return;
      }

      const requestId = nextSearchRequestId(++nextRequestSequence);
      const sessionId = nextSearchSessionId(nextRequestSequence);
      const command: SearchStartCommand = {
        type: "search/lifecycle",
        action: "start",
        requestId,
        workspaceId: input.workspaceId,
        sessionId,
        query,
        cwd: input.cwd,
        options: buildSearchOptions(currentWorkspace.options),
      };

      setWorkspaceState(set, input.workspaceId, (workspace) => ({
        ...workspace,
        query,
        status: "running",
        errorMessage: null,
        activeSessionId: sessionId,
        activeRequestId: requestId,
        groupsByPath: {},
        fileOrder: [],
        matchCount: 0,
        fileCount: 0,
        truncated: false,
        activeMatch: null,
        startedAt: null,
        completedAt: null,
        history: addSearchHistory(query, workspace.history),
        historyCursor: null,
      }));

      try {
        const reply = await searchBridge.startSearch(command);
        if (reply.action === "failed") {
          get().applyBridgeEvent(reply);
        }
      } catch (error) {
        setWorkspaceState(set, input.workspaceId, (workspace) => {
          if (workspace.activeSessionId !== sessionId) {
            return workspace;
          }

          return {
            ...workspace,
            status: "failed",
            errorMessage: errorMessage(error, "Unable to start search."),
            completedAt: new Date().toISOString(),
          };
        });
      }
    },
    stopBridgeSubscription() {
      subscription?.dispose();
      subscription = null;
    },
    toggleOption(workspaceId, option) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        options: {
          ...workspace.options,
          [option]: !workspace.options[option],
        },
      }));
    },
  }));

  return store;
}

export function getSearchFileGroups(workspace: SearchWorkspaceState): SearchFileResultGroup[] {
  return workspace.fileOrder
    .map((path) => workspace.groupsByPath[path])
    .filter((group): group is SearchFileResultGroup => Boolean(group));
}

export function getSearchMatches(workspace: SearchWorkspaceState): SearchMatch[] {
  return getSearchFileGroups(workspace).flatMap((group) => group.matches);
}

export function buildSearchOptions(options: SearchPanelOptionsState): SearchOptions {
  return {
    caseSensitive: options.caseSensitive,
    regex: options.regex,
    wholeWord: options.wholeWord,
    includeGlobs: splitGlobInput(options.includeText),
    excludeGlobs: splitGlobInput(options.excludeText),
    useGitIgnore: options.useGitIgnore,
  };
}

function createInitialWorkspaceState(): SearchWorkspaceState {
  return {
    query: "",
    replaceText: "",
    replaceMode: false,
    advancedOpen: false,
    options: {
      caseSensitive: false,
      regex: false,
      wholeWord: false,
      includeText: "",
      excludeText: "",
      useGitIgnore: true,
    },
    status: "idle",
    errorMessage: null,
    activeSessionId: null,
    activeRequestId: null,
    history: [],
    historyCursor: null,
    groupsByPath: {},
    fileOrder: [],
    matchCount: 0,
    fileCount: 0,
    truncated: false,
    activeMatch: null,
    startedAt: null,
    completedAt: null,
  };
}

function setWorkspaceState(
  set: StoreApi<SearchStoreState>["setState"],
  workspaceId: WorkspaceId,
  update: (workspace: SearchWorkspaceState) => SearchWorkspaceState,
): void {
  set((state) => ({
    workspaceById: {
      ...state.workspaceById,
      [workspaceId]: update(state.workspaceById[workspaceId] ?? createInitialWorkspaceState()),
    },
  }));
}

function applySearchBridgeEventToState(
  state: SearchStoreState,
  event: SearchBridgeEvent,
): Partial<SearchStoreState> | SearchStoreState {
  const workspace = state.workspaceById[event.workspaceId];
  if (!workspace || workspace.activeSessionId !== event.sessionId) {
    return state;
  }

  if (event.type === "search/relay") {
    return {
      workspaceById: {
        ...state.workspaceById,
        [event.workspaceId]: appendSearchResults(workspace, event),
      },
    };
  }

  switch (event.action) {
    case "started":
      return {
        workspaceById: {
          ...state.workspaceById,
          [event.workspaceId]: {
            ...workspace,
            status: "running",
            startedAt: event.startedAt,
          },
        },
      };
    case "completed":
      return {
        workspaceById: {
          ...state.workspaceById,
          [event.workspaceId]: {
            ...workspace,
            status: "completed",
            truncated: workspace.truncated || event.truncated,
            fileCount: Math.max(workspace.fileCount, Math.min(event.fileCount, workspace.fileOrder.length)),
            completedAt: event.completedAt,
          },
        },
      };
    case "failed":
      return {
        workspaceById: {
          ...state.workspaceById,
          [event.workspaceId]: {
            ...workspace,
            status: "failed",
            errorMessage: event.message,
            completedAt: event.failedAt,
          },
        },
      };
    case "canceled":
      return {
        workspaceById: {
          ...state.workspaceById,
          [event.workspaceId]: {
            ...workspace,
            status: "canceled",
            truncated: workspace.truncated || event.truncated,
            completedAt: event.canceledAt,
          },
        },
      };
  }
}

function appendSearchResults(
  workspace: SearchWorkspaceState,
  event: SearchResultChunkMessage,
): SearchWorkspaceState {
  const remaining = SEARCH_RESULT_LIMIT - workspace.matchCount;
  if (remaining <= 0) {
    return {
      ...workspace,
      truncated: true,
    };
  }

  const acceptedResults = event.results.slice(0, remaining);
  const groupsByPath: Record<string, SearchFileResultGroup> = { ...workspace.groupsByPath };
  const fileOrder = [...workspace.fileOrder];
  let nextOrdinal = workspace.matchCount;

  for (const result of acceptedResults) {
    const existingGroup = groupsByPath[result.path];
    if (!existingGroup) {
      groupsByPath[result.path] = {
        path: result.path,
        matches: [],
      };
      fileOrder.push(result.path);
    }

    const match: SearchMatch = {
      ...result,
      id: `${event.sessionId}:${nextOrdinal}`,
      ordinal: nextOrdinal,
    };
    nextOrdinal += 1;

    groupsByPath[result.path] = {
      path: result.path,
      matches: [...groupsByPath[result.path]!.matches, match],
    };
  }

  return {
    ...workspace,
    groupsByPath,
    fileOrder,
    matchCount: workspace.matchCount + acceptedResults.length,
    fileCount: fileOrder.length,
    truncated: workspace.truncated || event.truncated || acceptedResults.length < event.results.length,
  };
}

function addSearchHistory(query: string, history: readonly string[]): string[] {
  return [query, ...history.filter((entry) => entry !== query)].slice(0, SEARCH_HISTORY_LIMIT);
}

function nextHistoryCursor(
  history: readonly string[],
  cursor: number | null,
  direction: SearchHistoryDirection,
): number {
  if (cursor === null) {
    return direction === "previous" ? 0 : history.length - 1;
  }

  if (direction === "previous") {
    return (cursor + 1) % history.length;
  }

  return (cursor - 1 + history.length) % history.length;
}

function splitGlobInput(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function nextSearchRequestId(sequence: number): string {
  return `search-req-${Date.now()}-${sequence}`;
}

function nextSearchSessionId(sequence: number): string {
  return `search-session-${Date.now()}-${sequence}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
