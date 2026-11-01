import { describe, expect, test } from "bun:test";
import {
  rootPathFromLocation,
  WorkspaceLocationSchema,
  WorkspaceMetaSchema,
  workspaceLocationKey,
} from "../../../../src/shared/types/workspace";

describe("WSL workspace location", () => {
  test("parses a distribution and a path inside it", () => {
    const location = WorkspaceLocationSchema.parse({
      kind: "wsl",
      distro: "Ubuntu",
      remotePath: "/home/me/project",
    });

    expect(location).toEqual({ kind: "wsl", distro: "Ubuntu", remotePath: "/home/me/project" });
    expect(rootPathFromLocation(location)).toBe("/home/me/project");
  });

  test("keeps the cached Linux architecture and refuses an empty distribution", () => {
    expect(
      WorkspaceLocationSchema.parse({
        kind: "wsl",
        distro: "Ubuntu",
        remotePath: "/",
        remoteArch: { os: "linux", arch: "arm64" },
      }),
    ).toMatchObject({ remoteArch: { os: "linux", arch: "arm64" } });
    expect(
      WorkspaceLocationSchema.safeParse({ kind: "wsl", distro: "", remotePath: "/" }).success,
    ).toBe(false);
  });

  test("keys by distribution and path, apart from a local or SSH folder of the same path", () => {
    const wsl = { kind: "wsl" as const, distro: "Ubuntu", remotePath: "/home/me/project/" };

    expect(workspaceLocationKey(wsl)).toBe("wsl:Ubuntu:/home/me/project");
    expect(workspaceLocationKey({ ...wsl, distro: "Debian" })).not.toBe(workspaceLocationKey(wsl));
    expect(workspaceLocationKey({ kind: "local", rootPath: "/home/me/project" })).not.toBe(
      workspaceLocationKey(wsl),
    );
  });

  test("fills the deprecated rootPath of a stored workspace from the path", () => {
    const meta = WorkspaceMetaSchema.parse({
      id: "8f0c1b2e-3d4a-4b5c-9d6e-7f8091a2b3c4",
      name: "project",
      location: { kind: "wsl", distro: "Ubuntu", remotePath: "/home/me/project" },
      colorTone: "default",
      pinned: false,
      lastOpenedAt: "2026-10-31T00:00:00.000Z",
      tabs: [],
    });

    expect(meta.rootPath).toBe("/home/me/project");
  });
});
