/**
 * Scenario tests for .gitignore append-if-missing semantics.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendIgnoreEntry } from "../../../../src/main/git/git-ignore";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("appendIgnoreEntry", () => {
  test("appends once, preserves a trailing newline, and reports alreadyIgnored on second click", async () => {
    const root = makeRoot();
    const ignorePath = path.join(root, ".gitignore");
    fs.writeFileSync(ignorePath, "dist\n.env", "utf8");

    await expect(appendIgnoreEntry(root, "src/generated file.txt")).resolves.toEqual({
      added: true,
      alreadyIgnored: false,
    });
    expect(fs.readFileSync(ignorePath, "utf8")).toBe("dist\n.env\nsrc/generated file.txt\n");

    await expect(appendIgnoreEntry(root, "src/generated file.txt")).resolves.toEqual({
      added: false,
      alreadyIgnored: true,
    });
    expect(fs.readFileSync(ignorePath, "utf8")).toBe("dist\n.env\nsrc/generated file.txt\n");
  });

  test("dedupes lightly normalized existing anchored entries", async () => {
    const root = makeRoot();
    const ignorePath = path.join(root, ".gitignore");
    fs.writeFileSync(ignorePath, "/logs/app.log\n", "utf8");

    await expect(appendIgnoreEntry(root, "logs/app.log")).resolves.toEqual({
      added: false,
      alreadyIgnored: true,
    });
    expect(fs.readFileSync(ignorePath, "utf8")).toBe("/logs/app.log\n");
  });
});

/** Creates an isolated repository root fixture. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-ignore-"));
  roots.push(root);
  return root;
}
