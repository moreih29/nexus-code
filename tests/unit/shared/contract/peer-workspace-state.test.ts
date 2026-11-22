import { expect, test } from "bun:test";
import { peerWorkspaceId } from "../../../../src/shared/fs/peer-url";
import { ipcContract } from "../../../../src/shared/ipc/contract";
import {
  AppStateSchema,
  WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX,
} from "../../../../src/shared/types/app-state";

test("workspace sidebar folds are optional and bounded in storage and appState IPC", () => {
  const schemas = [
    AppStateSchema,
    ipcContract.appState.call.get.result,
    ipcContract.appState.call.set.args,
  ];
  const folds = Array.from({ length: WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX }, (_, i) => `device-${i}`);
  for (const schema of schemas) {
    expect(schema.parse({}).workspaceSidebarFoldedPeers).toBeUndefined();
    expect(
      schema.parse({ workspaceSidebarFoldedPeers: folds }).workspaceSidebarFoldedPeers,
    ).toEqual(folds);
    expect(schema.safeParse({ workspaceSidebarFoldedPeers: [...folds, "extra"] }).success).toBe(
      false,
    );
  }
});

test("peer IDs fail local layout, files panel and activation schema checks", () => {
  const id = peerWorkspaceId("device", "workspace");
  const layout = {
    root: {
      kind: "leaf",
      id: "123e4567-e89b-12d3-a456-426614174000",
      tabIds: [],
      activeTabId: null,
    },
    activeGroupId: "123e4567-e89b-12d3-a456-426614174000",
    tabs: [],
  };
  expect(
    AppStateSchema.shape.layoutByWorkspace.safeParse({ [layout.activeGroupId]: layout }).success,
  ).toBe(true);
  for (const schema of [AppStateSchema, ipcContract.appState.call.set.args]) {
    expect(schema.safeParse({ filesPanelModeByWorkspace: { [id]: "tree" } }).success).toBe(false);
    expect(schema.safeParse({ layoutByWorkspace: { [id]: layout } }).success).toBe(false);
  }
  expect(ipcContract.workspace.call.activate.args.safeParse({ id }).success).toBe(false);
});
