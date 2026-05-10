/**
 * Commit-detail parser for the History panel. The Git command uses NUL field
 * separators so multi-line commit messages and paths with whitespace do not
 * need ad-hoc line parsing.
 */
import type { CommitDetail, CommitFileChange } from "../../shared/types/git";
import { GitError } from "./git-error";

const DETAIL_FIELD_SEPARATOR = "\x00";
const DETAIL_HEADER_FIELD_COUNT = 7;
const DETAIL_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%cI%x00%s%x00%B%x00";

/**
 * Builds the `git show` argv used to read one commit's metadata and changed
 * files. Merge commits are still read through the same command; the parser
 * intentionally suppresses file entries for multi-parent commits.
 */
export function buildCommitDetailArgs(sha: string): string[] {
  const trimmed = sha.trim();
  if (trimmed.length === 0) {
    throw new GitError("ref-not-found", "Commit SHA is required.");
  }
  return [
    "show",
    "--no-ext-diff",
    "--find-renames",
    "--name-status",
    "-z",
    `--format=${DETAIL_FORMAT}`,
    trimmed,
  ];
}

/**
 * Parses `git show --name-status -z` output into the renderer-facing detail
 * shape. Rename and copy entries carry `oldPath`; merge commits return an
 * empty file list because parent-diff semantics are outside the MVP.
 */
export function parseCommitDetailOutput(stdout: string): CommitDetail {
  const fields = stdout.split(DETAIL_FIELD_SEPARATOR);
  if (fields.length < DETAIL_HEADER_FIELD_COUNT) {
    throw new GitError("unknown", "Could not parse commit detail.");
  }

  const [sha, parentsRaw, author, authorEmail, committerTs, subject, messageRaw] = fields;
  if (!sha) {
    throw new GitError("unknown", "Could not parse commit detail SHA.");
  }

  const parents = splitParents(parentsRaw);
  const message = trimTrailingNewlines(messageRaw ?? "");
  const body = extractBody(message, subject ?? "");
  const fileTokens = fields.slice(DETAIL_HEADER_FIELD_COUNT).filter((field) => field.length > 0);

  return {
    sha,
    parents,
    subject: subject ?? firstMessageLine(message),
    author: author ?? "",
    authorEmail: authorEmail ?? "",
    committerTs: committerTs ?? "",
    message,
    body,
    files: parents.length > 1 ? [] : parseNameStatusTokens(fileTokens),
  };
}

/**
 * Converts NUL-separated `--name-status` tokens into file changes. Git emits
 * `R100\0old\0new` and `C100\0old\0new` for renames/copies; all other status
 * entries use `STATUS\0path`.
 */
export function parseNameStatusTokens(tokens: readonly string[]): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = normalizeNameStatusToken(tokens[i++]);
    if (!status) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = normalizeNameStatusToken(tokens[i++]);
      const path = normalizeNameStatusToken(tokens[i++]);
      if (!oldPath || !path) break;
      files.push({ status, oldPath, path });
      continue;
    }

    const path = normalizeNameStatusToken(tokens[i++]);
    if (!path) break;
    files.push({ status, path });
  }
  return files;
}

/** Removes the single separator newline Git prints before name-status data. */
function normalizeNameStatusToken(value: string | undefined): string {
  return (value ?? "").replace(/^(?:\r?\n)+/u, "");
}

/**
 * Returns the body portion after the subject and optional blank separator.
 */
function extractBody(message: string, subject: string): string {
  if (message.length === 0) return "";
  const lines = message.split(/\r?\n/);
  if (lines[0] === subject) {
    if (lines[1] === "") return lines.slice(2).join("\n").trim();
    return lines.slice(1).join("\n").trim();
  }
  return lines.slice(1).join("\n").trim();
}

/**
 * Splits the raw parent field Git emits as a space-separated SHA list.
 */
function splitParents(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(" ")
    .map((parent) => parent.trim())
    .filter((parent) => parent.length > 0);
}

/**
 * Removes only trailing newlines from `%B`, preserving intentional body
 * spacing within the message.
 */
function trimTrailingNewlines(value: string): string {
  return value.replace(/(?:\r?\n)+$/u, "");
}

/**
 * Fallback subject extraction for malformed output where `%s` was empty.
 */
function firstMessageLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? "";
}
