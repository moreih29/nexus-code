import { describe, expect, it } from "bun:test";
import { restoreLayoutOrigins } from "../../../../../src/main/features/app-state/layout-origins";
import type { AppState } from "../../../../../src/shared/types/app-state";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const WS = "123e4567-e89b-12d3-a456-426614174000";

function stateWith(filePath: string, origin?: "external"): Readonly<AppState> {
  return {
    layoutByWorkspace: {
      [WS]: {
        root: { kind: "leaf", groupId: "123e4567-e89b-12d3-a456-426614174001" },
        activeGroupId: "123e4567-e89b-12d3-a456-426614174001",
        tabs: [
          {
            id: "123e4567-e89b-12d3-a456-426614174002",
            type: "editor",
            props: { filePath, workspaceId: WS, ...(origin ? { origin } : {}) },
          },
        ],
      },
    },
  } as unknown as Readonly<AppState>;
}

const workspace = {
  id: WS,
  name: "proj",
  rootPath: "C:/w",
  location: { kind: "local", rootPath: "C:/w" },
} as unknown as WorkspaceMeta;

const restoredPaths = (state: Readonly<AppState>) =>
  restoreLayoutOrigins(state, [workspace]).layoutByWorkspace?.[WS]?.tabs.map((tab) =>
    tab.type === "editor" ? tab.props.filePath : null,
  );

describe("restoreLayoutOrigins", () => {
  it("gives an external tab saved with a backslash share path its slash form", () => {
    expect(
      restoredPaths(stateWith(String.raw`\\127.0.0.1\qa-none-46\picked.txt`, "external")),
    ).toEqual(["//127.0.0.1/qa-none-46/picked.txt"]);
  });

  it("keeps other external tabs as saved", () => {
    expect(restoredPaths(stateWith("//nas/share/a.txt", "external"))).toEqual([
      "//nas/share/a.txt",
    ]);
    expect(restoredPaths(stateWith("D:/out/a.txt", "external"))).toEqual(["D:/out/a.txt"]);
  });
});
