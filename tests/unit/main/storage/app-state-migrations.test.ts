/**
 * App state an earlier version stored, under the names the agent list had
 * as the "sessions" tab, loads under this version's names.
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

function layoutWith(listType: string) {
  return {
    root: { kind: "leaf", id: LEAF, tabIds: [TERMINAL, LIST], activeTabId: LIST },
    activeGroupId: LEAF,
    tabs: [
      { id: TERMINAL, type: "terminal", title: "터미널", props: { cwd: "/tmp" } },
      { id: LIST, type: listType, title: "Agents", props: {} },
    ],
  };
}

describe("migrateAppState", () => {
  it("renames the agent list's fields and its tabs' type", () => {
    const migrated = migrateAppState({
      sessionsListRatio: 0.4,
      sessionsViewDefault: "task",
      sessionsViewByWorkspace: { [WS]: "status" },
      layoutByWorkspace: { [WS]: layoutWith("sessions") },
      sidebarWidth: 240,
    }) as Record<string, unknown>;
    expect(migrated).toEqual({
      agentListRatio: 0.4,
      agentListViewDefault: "task",
      agentListViewByWorkspace: { [WS]: "status" },
      layoutByWorkspace: { [WS]: layoutWith("agent-list") },
      sidebarWidth: 240,
    });
  });

  it("keeps a field already stored under its new name over the old one", () => {
    expect(migrateAppState({ sessionsListRatio: 0.4, agentListRatio: 0.6 })).toEqual({
      agentListRatio: 0.6,
    });
  });

  it("leaves state with nothing to rename, and what is not state, as it is", () => {
    const state = { sidebarWidth: 240, layoutByWorkspace: { [WS]: layoutWith("agent-list") } };
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

  it("loads it under this version's names, its agent list tab and all", () => {
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
    expect(state.agentListRatio).toBe(0.35);
    expect(state.agentListViewDefault).toBe("task");
    expect(state.layoutByWorkspace?.[WS]?.tabs.map((tab) => tab.type)).toEqual([
      "terminal",
      "agent-list",
    ]);
    expect(fs.existsSync(`${filePath}.invalid`)).toBe(false);
  });
});
