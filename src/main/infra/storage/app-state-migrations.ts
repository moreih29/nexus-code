/**
 * App state stored by an earlier version, brought to this version's names
 * before it is validated: what the agent list keeps was stored under the
 * names it had as the "sessions" tab, and the agent list was a tab, which
 * is now a view of the files panel.
 */

/** Fields stored under an earlier name, by the name they have now. */
const RENAMED_FIELDS: Readonly<Record<string, string>> = {
  sessionsViewDefault: "agentListViewDefault",
  sessionsViewByWorkspace: "agentListViewByWorkspace",
};

/** Fields an earlier version stored that nothing reads now. */
const DROPPED_FIELDS: readonly string[] = [
  // The agent list tab's list width, as a share of the tab's.
  "sessionsListRatio",
  "agentListRatio",
];

/**
 * Tab types an earlier version stored that there are no tabs of now: the
 * agent list's tab, under both its names. Its workspace's layout drops the
 * tab when it loads, as it does any tab it does not have.
 */
const DROPPED_TAB_TYPES: ReadonlySet<string> = new Set(["sessions", "agent-list"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A workspace's stored layout without the tabs there are none of now. */
function migrateLayout(layout: unknown): unknown {
  if (!isRecord(layout) || !Array.isArray(layout.tabs)) return layout;
  const tabs = layout.tabs.filter(
    (tab: unknown) =>
      !(isRecord(tab) && typeof tab.type === "string" && DROPPED_TAB_TYPES.has(tab.type)),
  );
  return tabs.length === layout.tabs.length ? layout : { ...layout, tabs };
}

/**
 * The stored state with earlier names renamed and what nothing reads now
 * dropped; a field already stored under its new name is kept over its old
 * one. Anything else is left as it is, for the schema to judge.
 */
export function migrateAppState(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const state: Record<string, unknown> = { ...raw };
  for (const [old, now] of Object.entries(RENAMED_FIELDS)) {
    if (!(old in state)) continue;
    if (!(now in state)) state[now] = state[old];
    delete state[old];
  }
  for (const field of DROPPED_FIELDS) delete state[field];
  if (isRecord(state.layoutByWorkspace)) {
    state.layoutByWorkspace = Object.fromEntries(
      Object.entries(state.layoutByWorkspace).map(([id, layout]) => [id, migrateLayout(layout)]),
    );
  }
  return state;
}
