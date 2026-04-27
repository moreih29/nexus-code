import { execFile as execFileCallback } from "node:child_process";
import { readFile as readFileDefault } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  WorkspaceDiffFile,
  WorkspaceDiffFileKind,
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../../../shared/src/contracts/workspace/workspace-diff";

export type ExecFileResult = {
  stdout: string;
  stderr: string;
};

export type WorkspaceDiffExecFile = (
  file: string,
  args: readonly string[],
) => Promise<ExecFileResult>;

export interface WorkspaceDiffServiceOptions {
  execFile?: WorkspaceDiffExecFile;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  now?: () => Date;
}

const execFileAsync = promisify(execFileCallback) as unknown as WorkspaceDiffExecFile;

export class WorkspaceDiffService {
  private readonly execFile: WorkspaceDiffExecFile;
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  private readonly now: () => Date;

  public constructor(options: WorkspaceDiffServiceOptions = {}) {
    this.execFile = options.execFile ?? execFileAsync;
    this.readFile = options.readFile ?? readFileDefault;
    this.now = options.now ?? (() => new Date());
  }

  public async readWorkspaceDiff(
    request: WorkspaceDiffRequest,
  ): Promise<WorkspaceDiffResult> {
    const workspacePath = typeof request.workspacePath === "string"
      ? request.workspacePath.trim()
      : "";

    if (!workspacePath) {
      return this.unavailable("workspacePath is required.");
    }

    try {
      const repoCheck = await this.execFile("git", [
        "-C",
        workspacePath,
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (repoCheck.stdout.trim() !== "true") {
        return this.unavailable("Workspace is not inside a git working tree.", workspacePath);
      }
    } catch {
      return this.unavailable("Git repository is unavailable.", workspacePath);
    }

    let statusOutput: string;
    try {
      const status = await this.execFile("git", [
        "-C",
        workspacePath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      statusOutput = status.stdout;
    } catch {
      return this.unavailable("Unable to read git status.", workspacePath);
    }

    const files = parsePorcelainStatus(statusOutput);
    const selectedFilePath = selectDiffFilePath(files, request.filePath ?? null);
    const diff = selectedFilePath
      ? await this.readSelectedDiff(workspacePath, files, selectedFilePath)
      : "";

    return {
      available: true,
      workspacePath,
      files,
      selectedFilePath,
      diff,
      generatedAt: this.timestamp(),
    };
  }

  private async readSelectedDiff(
    workspacePath: string,
    files: readonly WorkspaceDiffFile[],
    selectedFilePath: string,
  ): Promise<string> {
    const selectedFile = files.find((file) => file.path === selectedFilePath);
    if (!selectedFile) {
      return "";
    }

    if (selectedFile.kind === "untracked") {
      return this.readUntrackedPseudoDiff(workspacePath, selectedFilePath);
    }

    const sections: string[] = [];
    const [indexStatus, workTreeStatus] = selectedFile.status.padEnd(2, " ").slice(0, 2);

    if (workTreeStatus !== " ") {
      const unstaged = await this.readGitDiff(workspacePath, [
        "diff",
        "--no-ext-diff",
        "--",
        selectedFilePath,
      ]);
      if (unstaged.trim().length > 0) {
        sections.push(unstaged);
      }
    }

    if (indexStatus !== " " && indexStatus !== "?") {
      const staged = await this.readGitDiff(workspacePath, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--",
        selectedFilePath,
      ]);
      if (staged.trim().length > 0) {
        sections.push(staged);
      }
    }

    if (sections.length > 0) {
      return sections.join("\n");
    }

    return this.readGitDiff(workspacePath, [
      "diff",
      "--no-ext-diff",
      "--",
      selectedFilePath,
    ]);
  }

  private async readGitDiff(
    workspacePath: string,
    args: readonly string[],
  ): Promise<string> {
    try {
      const result = await this.execFile("git", ["-C", workspacePath, ...args]);
      return result.stdout;
    } catch {
      return "";
    }
  }

  private async readUntrackedPseudoDiff(
    workspacePath: string,
    filePath: string,
  ): Promise<string> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    const absoluteFilePath = path.resolve(absoluteWorkspacePath, filePath);
    const relativePath = path.relative(absoluteWorkspacePath, absoluteFilePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return "";
    }

    try {
      const content = await this.readFile(absoluteFilePath, "utf8");
      const addedLines = content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");
      return [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        addedLines,
      ].join("\n");
    } catch {
      return "";
    }
  }

  private unavailable(reason: string, workspacePath?: string): WorkspaceDiffResult {
    return {
      available: false,
      workspacePath,
      reason,
      generatedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function parsePorcelainStatus(output: string): WorkspaceDiffFile[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map(parsePorcelainStatusLine)
    .filter((file): file is WorkspaceDiffFile => file !== null);
}

function parsePorcelainStatusLine(line: string): WorkspaceDiffFile | null {
  const status = line.slice(0, 2);
  const rawPath = line.slice(3);
  const filePath = normalizePorcelainPath(rawPath);

  if (!filePath) {
    return null;
  }

  return {
    path: filePath,
    status,
    kind: statusToKind(status),
  };
}

function normalizePorcelainPath(rawPath: string): string {
  const renameSeparator = " -> ";
  const pathPart = rawPath.includes(renameSeparator)
    ? rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
    : rawPath;

  return pathPart.replace(/^"|"$/g, "");
}

function statusToKind(status: string): WorkspaceDiffFileKind {
  if (status === "??") {
    return "untracked";
  }
  if (status.includes("R")) {
    return "renamed";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status[0] !== " " && status[0] !== "?") {
    return "staged";
  }
  if (status.includes("M")) {
    return "modified";
  }

  return "unknown";
}

function selectDiffFilePath(
  files: readonly WorkspaceDiffFile[],
  requestedFilePath: string | null,
): string | null {
  if (requestedFilePath) {
    const exactMatch = files.find((file) => file.path === requestedFilePath);
    if (exactMatch) {
      return exactMatch.path;
    }
  }

  return files[0]?.path ?? null;
}
