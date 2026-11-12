/**
 * App state an earlier version stored loads in this version: the agent
 * list's fields under the names it had as the "sessions" tab, and its tab,
 * which is now a view of the files panel, gone from the layout.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateAppState } from "../../../../src/main/infra/storage/app-state-migrations";
import { StateService } from "../../../../src/main/infra/storage/state-service";

const WS = "123e4567-e89b-12d3-a456-426614174000";
const LEAF = "123e4567-e89b-12d3-a456-426614174001";
const LIST = "123e4567-e89b-12d3-a456-426614174002";
const TERMINAL = "123e4567-e89b-12d3-a456-426614174003";

const terminalTab = { id: TERMINAL, type: "terminal", title: "터미널", props: { cwd: "/tmp" } };

/** A layout with a terminal and, when its type is given, an agent list tab shown in front. */
function layoutWith(listType?: string) {
  return {
    root: { kind: "leaf", id: LEAF, tabIds: [TERMINAL, LIST], activeTabId: LIST },
    activeGroupId: LEAF,
    tabs: listType
      ? [terminalTab, { id: LIST, type: listType, title: "Agents", props: {} }]
      : [terminalTab],
  };
}

describe("migrateAppState", () => {
  it("renames the agent list's fields and drops its tab and its list width", () => {
    const migrated = migrateAppState({
      sessionsListRatio: 0.4,
      sessionsViewDefault: "task",
      sessionsViewByWorkspace: { [WS]: "status" },
      layoutByWorkspace: { [WS]: layoutWith("sessions") },
      sidebarWidth: 240,
    }) as Record<string, unknown>;
    expect(migrated).toEqual({
      agentListViewDefault: "task",
      agentListViewByWorkspace: { [WS]: "status" },
      layoutByWorkspace: { [WS]: layoutWith() },
      sidebarWidth: 240,
    });
  });

  it("drops the tab under its later name too, with the width it kept", () => {
    expect(
      migrateAppState({
        agentListRatio: 0.6,
        layoutByWorkspace: { [WS]: layoutWith("agent-list") },
      }),
    ).toEqual({ layoutByWorkspace: { [WS]: layoutWith() } });
  });

  it("keeps a field already stored under its new name over the old one", () => {
    expect(
      migrateAppState({ sessionsViewDefault: "task", agentListViewDefault: "status" }),
    ).toEqual({ agentListViewDefault: "status" });
  });

  it("leaves state with nothing to change, and what is not state, as it is", () => {
    const state = { sidebarWidth: 240, layoutByWorkspace: { [WS]: layoutWith() } };
    expect(migrateAppState(state)).toEqual(state);
    expect(migrateAppState(null)).toBeNull();
    expect(migrateAppState([1])).toEqual([1]);
  });
});

describe("StateService with an earlier version's state", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-migration-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads it under this version's names, without its agent list tab", () => {
    const filePath = path.join(dir, "state.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessionsListRatio: 0.35,
        sessionsViewDefault: "task",
        layoutByWorkspace: { [WS]: layoutWith("sessions") },
      }),
    );
    const state = new StateService(filePath).getState();
    expect(state.agentListViewDefault).toBe("task");
    expect("agentListRatio" in state).toBe(false);
    expect(state.layoutByWorkspace?.[WS]?.tabs.map((tab) => tab.type)).toEqual(["terminal"]);
    expect(fs.existsSync(`${filePath}.invalid`)).toBe(false);
  });
});
