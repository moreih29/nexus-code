/**
 * App state stored by an earlier version, brought to this version's names
 * before it is validated: what the agent list keeps was stored under the
 * names it had as the "sessions" tab.
 */

/** Fields stored under an earlier name, by the name they have now. */
const RENAMED_FIELDS: Readonly<Record<string, string>> = {
  sessionsListRatio: "agentListRatio",
  sessionsViewDefault: "agentListViewDefault",
  sessionsViewByWorkspace: "agentListViewByWorkspace",
};

/** Tab types stored under an earlier name, by the name they have now. */
const RENAMED_TAB_TYPES: Readonly<Record<string, string>> = {
  sessions: "agent-list",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A workspace's stored layout with its tabs' earlier types renamed. */
function migrateLayout(layout: unknown): unknown {
  if (!isRecord(layout) || !Array.isArray(layout.tabs)) return layout;
  let changed = false;
  const tabs = layout.tabs.map((tab: unknown) => {
    if (!isRecord(tab) || typeof tab.type !== "string") return tab;
    const type = RENAMED_TAB_TYPES[tab.type];
    if (type === undefined) return tab;
    changed = true;
    return { ...tab, type };
  });
  return changed ? { ...layout, tabs } : layout;
}

/**
 * The stored state with earlier names renamed; a field already stored
 * under its new name is kept over its old one. Anything else is left as it
 * is, for the schema to judge.
 */
export function migrateAppState(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const state: Record<string, unknown> = { ...raw };
  for (const [old, now] of Object.entries(RENAMED_FIELDS)) {
    if (!(old in state)) continue;
    if (!(now in state)) state[now] = state[old];
    delete state[old];
  }
  if (isRecord(state.layoutByWorkspace)) {
    state.layoutByWorkspace = Object.fromEntries(
      Object.entries(state.layoutByWorkspace).map(([id, layout]) => [id, migrateLayout(layout)]),
    );
  }
  return state;
}
