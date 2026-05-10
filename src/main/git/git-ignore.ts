/**
 * .gitignore mutation helpers for Source Control context-menu actions.
 *
 * The helper performs an idempotent append-if-missing write and uses a
 * tmp-file + rename sequence so interrupted writes do not leave a partial
 * .gitignore behind.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitIgnoreAppendResult } from "../../shared/types/git";
import { GitError } from "./git-error";

/**
 * Appends a normalized repository-relative path to `.gitignore` unless an
 * equivalent line already exists. Existing file content is otherwise left
 * untouched; when appending, the result always ends with one trailing newline.
 */
export async function appendIgnoreEntry(
  repoRoot: string,
  relPath: string,
): Promise<GitIgnoreAppendResult> {
  const pattern = normalizeIgnorePattern(relPath);
  const ignorePath = path.join(repoRoot, ".gitignore");
  const current = await readExistingGitignore(ignorePath);

  if (containsIgnorePattern(current, pattern)) {
    return { added: false, alreadyIgnored: true };
  }

  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  const next = `${prefix}${pattern}\n`;
  await atomicWrite(ignorePath, next);
  return { added: true, alreadyIgnored: false };
}

/** Reads `.gitignore`, treating absence as an empty ignore file. */
async function readExistingGitignore(ignorePath: string): Promise<string> {
  try {
    return await fs.readFile(ignorePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw gitignoreWriteError(ignorePath, error);
  }
}

/** Writes content through a sibling tmp path before renaming into place. */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw gitignoreWriteError(targetPath, error);
  }
}

/** Checks existing non-comment lines after light normalization. */
function containsIgnorePattern(content: string, pattern: string): boolean {
  return content
    .split(/\r?\n/)
    .map(normalizeExistingPatternLine)
    .some((line) => line === pattern);
}

/** Normalizes a new ignore entry to the Git slash-separated path form. */
function normalizeIgnorePattern(relPath: string): string {
  const slashPath = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = slashPath.split("/").filter((part) => part.length > 0).join("/");
  if (
    normalized.length === 0 ||
    slashPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new GitError("path-not-in-repo", `Path ${relPath} is outside repository`);
  }
  return normalized;
}

/** Normalizes an existing line for the simple dedupe comparison. */
function normalizeExistingPatternLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) return "";
  return trimmed.replace(/^\//, "").replace(/^\.\//, "");
}

/** Wraps filesystem failures in the typed gitignore-write-failed kind. */
function gitignoreWriteError(ignorePath: string, cause: unknown): GitError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new GitError("gitignore-write-failed", `Could not write ${ignorePath}: ${message}`, {
    cause,
  });
}

/** Identifies an absent .gitignore without hiding other filesystem failures. */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}
