const RENAMED_FIELDS: Readonly<Record<string, string>> = {
  sessionsViewDefault: "agentListViewDefault",
  sessionsViewByWorkspace: "agentListViewByWorkspace",
};

const DROPPED_FIELDS: readonly string[] = ["sessionsListRatio", "agentListRatio"];

const DROPPED_TAB_TYPES: ReadonlySet<string> = new Set(["sessions", "agent-list"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function migrateLayout(layout: unknown): unknown {
  if (!isRecord(layout) || !Array.isArray(layout.tabs)) return layout;
  const tabs = layout.tabs.filter(
    (tab: unknown) =>
      !(isRecord(tab) && typeof tab.type === "string" && DROPPED_TAB_TYPES.has(tab.type)),
  );
  return tabs.length === layout.tabs.length ? layout : { ...layout, tabs };
}

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
