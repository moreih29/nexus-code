/**
 * The folder nexus workspace add is given, found among the listed
 * workspaces through a link, as macOS's /tmp is to /private/tmp.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listedAt } from "../../../../src/main/features/cli/listed";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const top = mkdtempSync(path.join(tmpdir(), "nexus-listed-"));
const real = path.join(realpathSync(top), "real");
mkdirSync(path.join(real, "app"), { recursive: true });
mkdirSync(path.join(real, "lib"));
const link = path.join(top, "link");
// A junction needs no privilege on Windows; elsewhere the type is ignored.
symlinkSync(real, link, "junction");
afterAll(() => rmSync(top, { recursive: true, force: true }));

const local = (id: string, rootPath: string) =>
  ({ id, name: id, location: { kind: "local", rootPath }, rootPath }) as WorkspaceMeta;

describe("listedAt", () => {
  const workspaces = [local("app", path.join(link, "app"))];

  test("finds a workspace listed by a link from the folder's real path", async () => {
    const found = await listedAt(workspaces, { kind: "local", rootPath: path.join(real, "app") });
    expect(found?.id).toBe("app");
  });

  test("finds one spelled the same, trailing slash aside", async () => {
    const found = await listedAt(workspaces, { kind: "local", rootPath: `${link}/app/` });
    expect(found?.id).toBe("app");
  });

  test("finds none for another folder, or one that is not there", async () => {
    expect(await listedAt(workspaces, { kind: "local", rootPath: path.join(real, "lib") })).toBe(
      undefined,
    );
    expect(await listedAt(workspaces, { kind: "local", rootPath: path.join(real, "gone") })).toBe(
      undefined,
    );
  });

  test("compares a remote folder as spelled", async () => {
    const ssh = {
      ...local("box", "/srv/app"),
      location: { kind: "ssh", host: "box", remotePath: "/srv/app" },
    } as WorkspaceMeta;
    const at = (remotePath: string) =>
      listedAt([ssh], { kind: "ssh", host: "box", remotePath }, async () => {
        throw new Error("a remote folder is not looked at here");
      });
    expect((await at("/srv/app"))?.id).toBe("box");
    expect(await at("/srv/lib")).toBe(undefined);
  });
});
