/** A workspace's place as nexus prints it, for each kind of location. */
import { expect, test } from "bun:test";
import { describeLocation } from "../../../../src/main/features/cli/context";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../../src/shared/types/workspace";

const at = (location: WorkspaceLocation) => ({ location }) as WorkspaceMeta;

test("describeLocation names a local folder, an SSH host and a WSL distribution", () => {
  expect(describeLocation(at({ kind: "local", rootPath: "/w/app" }))).toBe("/w/app");
  expect(describeLocation(at({ kind: "ssh", host: "box", user: "me", remotePath: "/srv" }))).toBe(
    "me@box:/srv",
  );
  expect(describeLocation(at({ kind: "wsl", distro: "Ubuntu", remotePath: "/home/me/app" }))).toBe(
    "WSL Ubuntu:/home/me/app",
  );
});
