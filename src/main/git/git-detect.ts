/**
 * One-shot repository detector for a workspace root. The detector only
 * classifies the current root; GitRegistry owns caching and repository objects.
 */
import path from "node:path";
import type { RepoInfo } from "../../shared/types/git";
import type { GitBinary } from "./git-binary";
import { GitError } from "./git-error";
import { type GitProcessExecutor, runGit } from "./git-process";

const REV_PARSE_ARGS = ["rev-parse", "--show-toplevel", "--git-dir"] as const;

/**
 * Detects whether `root` belongs to a Git repository.
 *
 * Normal "not a repository" exits are reported as `{ kind: "non-repo" }`
 * rather than thrown so callers can render the initialize-repository path.
 * Other failures remain typed Git errors.
 */
export async function detectRepository(
  root: string,
  bin: GitBinary | string | null,
  signal?: AbortSignal,
  executor?: GitProcessExecutor,
): Promise<RepoInfo> {
  const binPath = typeof bin === "string" ? bin : bin?.path;
  if (!binPath) return { kind: "non-repo" };

  try {
    const { stdout } = await runGit({
      bin: binPath,
      cwd: root,
      args: REV_PARSE_ARGS,
      signal,
      executor,
    });
    return parseRevParseOutput(root, stdout);
  } catch (error) {
    if (error instanceof GitError && error.kind === "not-repo") {
      return { kind: "non-repo" };
    }
    throw error;
  }
}

/**
 * Converts the two-line `rev-parse` response into the shared RepoInfo shape.
 */
function parseRevParseOutput(root: string, stdout: string): RepoInfo {
  const lines = splitOutputLines(stdout);
  const topLevel = lines[0];
  const gitDir = lines[1];

  if (!topLevel || !gitDir) {
    throw new GitError("unknown", "git rev-parse did not return repository paths", {
      stdout,
      argv: REV_PARSE_ARGS,
    });
  }

  return {
    kind: "repo",
    topLevel: normalizeGitPath(root, topLevel),
    gitDir: normalizeGitPath(root, gitDir),
  };
}

/**
 * Drops the trailing newline Git adds while preserving spaces in paths.
 */
function splitOutputLines(stdout: string): string[] {
  const normalized = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  return normalized.split(/\r?\n/);
}

/**
 * Git can emit paths relative to cwd for some repo shapes; registry consumers
 * operate on absolute roots, so normalize relative results once here.
 */
function normalizeGitPath(root: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}
