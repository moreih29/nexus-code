/**
 * Defensive parsers that turn SQLite rows from per-workspace tables into the
 * typed shapes the rest of the main process consumes.
 *
 * Each parser is tolerant of partial / corrupted data: an unparseable row
 * falls back to the schema default rather than throwing, so a single bad
 * write never bricks workspace boot. Schema validation runs against the
 * shared zod schemas so any drift surfaces here before reaching the renderer.
 *
 * Helpers for "build a default panel state" also live here so the storage
 * module and tests have a single source of truth for the empty shape.
 */

import {
  DEFAULT_GIT_PANEL_STATE,
  type GitExpandedGroups,
  type GitExpandedTreeNodes,
  type GitPanelState,
  GitPanelStateSchema,
} from "../../../shared/types/git";

export const GIT_PANEL_COMMIT_DRAFT_KEY = "commitDraft";
export const GIT_PANEL_EXPANDED_GROUPS_KEY = "expandedGroups";
export const GIT_PANEL_EXPANDED_TREE_NODES_KEY = "expandedTreeNodes";
export const GIT_PANEL_COMMIT_OPTIONS_KEY = "commitOptions";
export const GIT_PANEL_AUTOFETCH_INTERVAL_MIN_KEY = "autofetchIntervalMin";
export const GIT_PANEL_AUTOFETCH_MANUAL_PAUSED_KEY = "autofetchManualPaused";
export const GIT_PANEL_PROTECTED_BRANCHES_KEY = "protectedBranches";
export const GIT_PANEL_PANEL_SEGMENT_KEY = "panelSegment";
export const GIT_PANEL_HISTORY_REF_KEY = "historyRef";
export const GIT_PANEL_HISTORY_SCOPE_KEY = "historyScope";

export interface GitPanelStateRow {
  key: string;
  value: string;
  commit_options?: string;
  autofetch_interval_min?: number;
  autofetch_manual_paused?: number;
  protected_branches?: string;
}

export function defaultGitExpandedGroups(): GitExpandedGroups {
  return { ...DEFAULT_GIT_PANEL_STATE.expandedGroups };
}

export function defaultGitExpandedTreeNodes(): GitExpandedTreeNodes {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
  };
}

export function defaultGitPanelState(): GitPanelState {
  return {
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: defaultGitExpandedGroups(),
    expandedTreeNodes: defaultGitExpandedTreeNodes(),
    commitOptions: { ...DEFAULT_GIT_PANEL_STATE.commitOptions },
    autofetchIntervalMin: DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin,
    autofetchManualPaused: DEFAULT_GIT_PANEL_STATE.autofetchManualPaused,
    protectedBranches: [...DEFAULT_GIT_PANEL_STATE.protectedBranches],
    panelSegment: DEFAULT_GIT_PANEL_STATE.panelSegment,
    historyRef: DEFAULT_GIT_PANEL_STATE.historyRef,
    historyScope: DEFAULT_GIT_PANEL_STATE.historyScope,
  };
}

export function parseGitExpandedGroups(
  workspaceId: string,
  raw: string | undefined,
): GitExpandedGroups | null {
  if (raw === undefined) {
    return defaultGitExpandedGroups();
  }

  try {
    const state = GitPanelStateSchema.parse({
      commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups: JSON.parse(raw) as unknown,
      expandedTreeNodes: DEFAULT_GIT_PANEL_STATE.expandedTreeNodes,
    });
    return state.expandedGroups;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state expandedGroups for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return null;
  }
}

export function parseGitExpandedTreeNodes(
  workspaceId: string,
  raw: string | undefined,
): GitExpandedTreeNodes {
  if (raw === undefined) {
    return defaultGitExpandedTreeNodes();
  }

  try {
    const state = GitPanelStateSchema.parse({
      commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups: DEFAULT_GIT_PANEL_STATE.expandedGroups,
      expandedTreeNodes: JSON.parse(raw) as unknown,
    });
    return state.expandedTreeNodes;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state expandedTreeNodes for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return defaultGitExpandedTreeNodes();
  }
}

/**
 * Parses the persisted commit option JSON, falling back to schema defaults
 * when the column or legacy key/value row is absent.
 */
export function parseGitCommitOptions(
  workspaceId: string,
  raw: string | undefined,
): GitPanelState["commitOptions"] {
  if (raw === undefined) {
    return { ...DEFAULT_GIT_PANEL_STATE.commitOptions };
  }

  try {
    const state = GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      commitOptions: JSON.parse(raw) as unknown,
    });
    return state.commitOptions;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state commitOptions for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return { ...DEFAULT_GIT_PANEL_STATE.commitOptions };
  }
}

/**
 * Parses the persisted autofetch interval. The value may come from SQLite as
 * a number column or from a legacy key/value row as a numeric string.
 */
export function parseGitAutofetchIntervalMin(
  workspaceId: string,
  raw: string | number | undefined,
): GitPanelState["autofetchIntervalMin"] {
  if (raw === undefined) {
    return DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin;
  }

  try {
    const state = GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      autofetchIntervalMin: typeof raw === "number" ? raw : Number(raw),
    });
    return state.autofetchIntervalMin;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state autofetchIntervalMin for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin;
  }
}

/**
 * Parses the persisted manual-pause flag from SQLite integer or legacy string
 * storage while preserving the default for absent values.
 */
export function parseGitAutofetchManualPaused(
  workspaceId: string,
  raw: string | number | undefined,
): boolean {
  if (raw === undefined) {
    return DEFAULT_GIT_PANEL_STATE.autofetchManualPaused;
  }

  try {
    const state = GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      autofetchManualPaused: raw === 1 || raw === "1" || raw === "true",
    });
    return state.autofetchManualPaused;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state autofetchManualPaused for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return DEFAULT_GIT_PANEL_STATE.autofetchManualPaused;
  }
}

/**
 * Parses the protected branch list JSON, defaulting to an empty list for fresh
 * workspaces and invalid persisted values.
 */
export function parseGitProtectedBranches(
  workspaceId: string,
  raw: string | undefined,
): GitPanelState["protectedBranches"] {
  if (raw === undefined) {
    return [...DEFAULT_GIT_PANEL_STATE.protectedBranches];
  }

  try {
    const state = GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      protectedBranches: JSON.parse(raw) as unknown,
    });
    return state.protectedBranches;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state protectedBranches for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return [...DEFAULT_GIT_PANEL_STATE.protectedBranches];
  }
}

/**
 * Parses the selected Source Control segment, defaulting to Changes for
 * workspaces saved before the History panel existed.
 */
export function parseGitPanelSegment(
  workspaceId: string,
  raw: string | undefined,
): GitPanelState["panelSegment"] {
  if (raw === undefined) return DEFAULT_GIT_PANEL_STATE.panelSegment;

  try {
    return GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      panelSegment: raw,
    }).panelSegment;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state panelSegment for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return DEFAULT_GIT_PANEL_STATE.panelSegment;
  }
}

/**
 * Parses the last viewed History ref, preserving HEAD as the no-selection
 * default for older workspaces.
 */
export function parseGitHistoryRef(
  workspaceId: string,
  raw: string | undefined,
): GitPanelState["historyRef"] {
  if (raw === undefined) return DEFAULT_GIT_PANEL_STATE.historyRef;

  try {
    return GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      historyRef: raw,
    }).historyRef;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state historyRef for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return DEFAULT_GIT_PANEL_STATE.historyRef;
  }
}

/** Parses the persisted history scope, defaulting legacy workspaces to single-ref history. */
export function parseGitHistoryScope(
  workspaceId: string,
  raw: string | undefined,
): GitPanelState["historyScope"] {
  if (raw === undefined) return DEFAULT_GIT_PANEL_STATE.historyScope;

  try {
    return GitPanelStateSchema.parse({
      ...defaultGitPanelState(),
      historyScope: raw,
    }).historyScope;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state historyScope for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return DEFAULT_GIT_PANEL_STATE.historyScope;
  }
}
