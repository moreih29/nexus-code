import { describe, expect, test } from "bun:test";

import { parsePorcelainStatus, WorkspaceDiffService } from "./workspace-diff-service";
import type { WorkspaceDiffExecFile } from "./workspace-diff-service";

const now = () => new Date("2026-04-26T12:00:00.000Z");

describe("WorkspaceDiffService", () => {
  test("returns unavailable when workspace is not a git repo", async () => {
    const service = new WorkspaceDiffService({
      now,
      execFile: async () => {
        throw new Error("not a repo");
      },
    });

    await expect(
      service.readWorkspaceDiff({ workspacePath: "/tmp/not-a-repo" }),
    ).resolves.toEqual({
      available: false,
      workspacePath: "/tmp/not-a-repo",
      reason: "Git repository is unavailable.",
      generatedAt: "2026-04-26T12:00:00.000Z",
    });
  });

  test("reads modified and staged diff for the selected file", async () => {
    const execFileCalls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: WorkspaceDiffExecFile = async (file, args) => {
      execFileCalls.push({ file, args });
      const command = args.join(" ");
      if (command.includes("rev-parse")) {
        return { stdout: "true\n", stderr: "" };
      }
      if (command.includes("status --porcelain")) {
        return { stdout: "MM src/app.ts\n M README.md\n", stderr: "" };
      }
      if (command.includes("diff --no-ext-diff -- src/app.ts")) {
        return { stdout: "diff --git a/src/app.ts b/src/app.ts\n+unstaged\n", stderr: "" };
      }
      if (command.includes("diff --cached --no-ext-diff -- src/app.ts")) {
        return { stdout: "diff --git a/src/app.ts b/src/app.ts\n+staged\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const service = new WorkspaceDiffService({ now, execFile });

    const result = await service.readWorkspaceDiff({
      workspacePath: "/repo",
      filePath: "src/app.ts",
    });

    expect(result).toEqual({
      available: true,
      workspacePath: "/repo",
      files: [
        { path: "src/app.ts", status: "MM", kind: "staged" },
        { path: "README.md", status: " M", kind: "modified" },
      ],
      selectedFilePath: "src/app.ts",
      diff: "diff --git a/src/app.ts b/src/app.ts\n+unstaged\n\ndiff --git a/src/app.ts b/src/app.ts\n+staged\n",
      generatedAt: "2026-04-26T12:00:00.000Z",
    });
    expect(execFileCalls.map((call) => call.args.join(" "))).toContain(
      "-C /repo diff --cached --no-ext-diff -- src/app.ts",
    );
  });

  test("returns an untracked pseudo diff", async () => {
    const service = new WorkspaceDiffService({
      now,
      execFile: async (_file, args) => {
        const command = args.join(" ");
        if (command.includes("rev-parse")) {
          return { stdout: "true\n", stderr: "" };
        }
        if (command.includes("status --porcelain")) {
          return { stdout: "?? notes/hello.txt\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
      readFile: async (filePath) => {
        expect(filePath).toBe("/repo/notes/hello.txt");
        return "hello\nworld";
      },
    });

    await expect(
      service.readWorkspaceDiff({ workspacePath: "/repo" }),
    ).resolves.toEqual({
      available: true,
      workspacePath: "/repo",
      files: [{ path: "notes/hello.txt", status: "??", kind: "untracked" }],
      selectedFilePath: "notes/hello.txt",
      diff: [
        "diff --git a/notes/hello.txt b/notes/hello.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/notes/hello.txt",
        "+hello",
        "+world",
      ].join("\n"),
      generatedAt: "2026-04-26T12:00:00.000Z",
    });
  });

  test("parses porcelain status lines", () => {
    expect(parsePorcelainStatus("R  old.txt -> new.txt\nA  added.ts\n D gone.ts\n")).toEqual([
      { path: "new.txt", status: "R ", kind: "renamed" },
      { path: "added.ts", status: "A ", kind: "added" },
      { path: "gone.ts", status: " D", kind: "deleted" },
    ]);
  });
});
