import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "../helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository discard source scoping", () => {
  realGitTest("working discard on an MM file preserves staged content", async () => {
    const root = makeRepo();
    try {
      const repo = newLocalGitRepository(
        "workspace-mm-working",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      makeMmFile(root);

      await repo.discard(["f.txt"], { source: "working" });

      expect(readIndexFile(root, "f.txt")).toBe("staged\n");
      expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("staged\n");
      expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe("M  f.txt\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("staged discard on an MM file preserves unstaged working content", async () => {
    const root = makeRepo();
    try {
      const repo = newLocalGitRepository(
        "workspace-mm-staged",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      makeMmFile(root);

      await repo.discard(["f.txt"], { source: "staged" });

      expect(readIndexFile(root, "f.txt")).toBe("base\n");
      expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("working\n");
      expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe(" M f.txt\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GitRepository selected paths", () => {
  realGitTest("stage, unstage and discard affect only the literal bracketed filename", async () => {
    const root = makeRepo();
    try {
      const selected = "[id].ts";
      const other = "i.ts";
      for (const file of [selected, other]) {
        fs.writeFileSync(path.join(root, file), "base\n");
      }
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "routes"]);
      for (const file of [selected, other]) {
        fs.writeFileSync(path.join(root, file), "modified\n");
      }
      const repo = newLocalGitRepository("routes", root, path.join(root, ".git"), gitOnPath!);

      await repo.stage([selected]);
      expect(readIndexFile(root, selected)).toBe("modified\n");
      expect(readIndexFile(root, other)).toBe("base\n");

      await repo.stage([other]);
      await repo.unstage([selected]);
      expect(readIndexFile(root, selected)).toBe("base\n");
      expect(readIndexFile(root, other)).toBe("modified\n");

      await repo.unstage([other]);
      await repo.discard([selected], { source: "working" });
      expect(fs.readFileSync(path.join(root, selected), "utf8")).toBe("base\n");
      expect(fs.readFileSync(path.join(root, other), "utf8")).toBe("modified\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("cleanup of an untracked bracketed filename preserves its sibling", async () => {
    const root = makeRepo();
    try {
      fs.writeFileSync(path.join(root, "[id].ts"), "selected\n");
      fs.writeFileSync(path.join(root, "i.ts"), "keep\n");
      const repo = newLocalGitRepository("routes", root, path.join(root, ".git"), gitOnPath!);

      await repo.discard(["[id].ts"], { source: "untracked" });

      expect(fs.existsSync(path.join(root, "[id].ts"))).toBe(false);
      expect(fs.readFileSync(path.join(root, "i.ts"), "utf8")).toBe("keep\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("check-ignore treats a leading colon as part of the requested filename", async () => {
    const root = makeRepo();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), ":ignored\n");
      const repo = newLocalGitRepository("ignored", root, path.join(root, ".git"), gitOnPath!);
      expect(await repo.checkIgnore([":ignored", ":unignored"])).toEqual([":ignored"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-discard-"));
  runGit(root, ["init"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "f.txt"), "base\n", "utf8");
  runGit(root, ["add", "f.txt"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

function makeMmFile(root: string): void {
  fs.writeFileSync(path.join(root, "f.txt"), "staged\n", "utf8");
  runGit(root, ["add", "f.txt"]);
  fs.writeFileSync(path.join(root, "f.txt"), "working\n", "utf8");
  expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe("MM f.txt\n");
}

function readIndexFile(root: string, relPath: string): string {
  return runGit(root, ["show", `:${relPath}`]);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath!, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function findGitOnPath(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
