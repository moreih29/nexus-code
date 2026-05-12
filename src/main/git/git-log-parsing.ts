/**
 * `git log` pretty-format constants plus the argv builder and record parsers
 * that go with them.
 *
 * The custom format encodes every field separated by `\x1f` (LOG_FIELD_SEPARATOR)
 * and terminates each record with `\x1e` (LOG_RECORD_SEPARATOR). That way the
 * commit body — which can contain newlines and arbitrary punctuation — never
 * collides with our delimiter set.
 *
 * Separators are exported so `GitRepository.streamLog` can chunk the raw
 * stdout against the same byte boundaries used to format it.
 */

import type { LogEntry, LogEntryRef } from "../../shared/types/git";
import { GitError } from "./git-error";
import type { GitLogArgs } from "./git-repository";

export const LOG_FIELD_SEPARATOR = "\x1f";
export const LOG_RECORD_SEPARATOR = "\x1e";
export const LOG_FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%s", "%b", "%D"];
export const LOG_FORMAT = `${LOG_FIELDS.join("%x1f")}%x1e`;
export const LOG_SOURCE_FORMAT = `${["%S", ...LOG_FIELDS].join("%x1f")}%x1e`;

/**
 * Builds a `git log` command that fetches one extra row when paginating.
 * Non-ref scopes read all matching refs directly, so skip-based pagination is
 * rejected and cursor pages omit Git-side bounds so streamLog can seek past
 * the cursor before enforcing the page limit.
 */
export function buildLogArgs(args: GitLogArgs): string[] {
  const scope = args.scope ?? "ref";
  if (scope !== "ref" && args.skip !== undefined) {
    throw new GitError("unknown", "`skip` is only supported for ref-scoped git logs.");
  }

  const afterSha = args.afterSha?.trim();
  const usesStreamCursorSeek = scope !== "ref" && afterSha !== undefined && afterSha.length > 0;
  const format = scope === "ref" ? LOG_FORMAT : LOG_SOURCE_FORMAT;
  const gitArgs = ["log", `--pretty=format:${format}`, "--date=iso-strict"];

  if (args.grep && args.grep.trim().length > 0) gitArgs.push(`--grep=${args.grep.trim()}`);
  if (scope === "ref" && args.skip && args.skip > 0) gitArgs.push(`--skip=${args.skip}`);
  if (args.limit && args.limit > 0 && !usesStreamCursorSeek) {
    gitArgs.push(`--max-count=${args.limit + 1}`);
  }
  if (scope === "all") gitArgs.push("--source", "--all");
  if (scope === "branches") gitArgs.push("--source", "--branches");
  if (scope === "ref" && afterSha && afterSha.length > 0) {
    gitArgs.push(`${afterSha}^@`);
  } else if (scope === "ref" && args.ref && args.ref.trim().length > 0) {
    gitArgs.push(args.ref);
  }

  return gitArgs;
}

interface ParseLogRecordOptions {
  readonly hasSource?: boolean;
}

/**
 * Parses one custom-formatted git log record. Source-aware records carry `%S`
 * as the first field; decoration refs always remain the final `%D` field so
 * commit bodies can still contain the field separator without losing text.
 */
export function parseLogRecord(
  record: string,
  options: ParseLogRecordOptions = {},
): LogEntry | null {
  const normalized = record.startsWith("\n") ? record.slice(1) : record;
  if (normalized.trim().length === 0) return null;

  const fields = normalized.split(LOG_FIELD_SEPARATOR);
  const offset = options.hasSource ? 1 : 0;
  if (fields.length < offset + LOG_FIELDS.length) return null;

  const sha = fields[offset];
  const shortSha = fields[offset + 1];
  const parents = fields[offset + 2];
  const authorName = fields[offset + 3];
  const authorEmail = fields[offset + 4];
  const authoredAt = fields[offset + 5];
  const subject = fields[offset + 6];
  const decorations = fields.at(-1) ?? "";
  const bodyParts = fields.slice(offset + 7, -1);
  if (!sha) return null;
  const body = bodyParts.join(LOG_FIELD_SEPARATOR).trim();

  return {
    sha,
    shortSha: shortSha || undefined,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    authorName: authorName ?? "",
    authorEmail: authorEmail || undefined,
    authoredAt: authoredAt ?? "",
    subject: subject ?? "",
    body: body.length > 0 ? body : undefined,
    refs: parseLogDecorations(decorations),
  };
}

/**
 * Parses Git's `%D` decoration list into normalized ref chips. The short
 * format is intentionally accepted because it is Git's default `%D` payload;
 * full `refs/*` names are also normalized when tests or future args use them.
 */
function parseLogDecorations(decorations: string): LogEntryRef[] {
  const refs = new Map<string, LogEntryRef>();

  const pushRef = (ref: LogEntryRef | null) => {
    if (!ref) return;
    const key = `${ref.kind}:${ref.name}`;
    const existing = refs.get(key);
    refs.set(key, existing ? { ...existing, isHead: existing.isHead || ref.isHead } : ref);
  };

  for (const rawPart of decorations.split(/,\s*/)) {
    const part = rawPart.trim();
    if (part.length === 0) continue;

    const arrowIndex = part.indexOf(" -> ");
    if (arrowIndex >= 0) {
      const source = part.slice(0, arrowIndex).trim();
      const target = part.slice(arrowIndex + 4).trim();
      const sourceRef = parseDecorationRef(source, false);
      pushRef(sourceRef);
      pushRef(parseDecorationRef(target, sourceRef?.kind === "head"));
      continue;
    }

    pushRef(parseDecorationRef(part, false));
  }

  return Array.from(refs.values());
}

/**
 * Converts a single decoration token into the shared ref schema, preserving
 * HEAD as its own chip while tagging the current branch target when Git emits
 * the `HEAD -> branch` symbolic-ref grammar.
 */
function parseDecorationRef(rawName: string, isHeadTarget: boolean): LogEntryRef | null {
  if (rawName.length === 0) return null;
  if (rawName === "HEAD") return { name: "HEAD", kind: "head", isHead: true };

  if (rawName.startsWith("tag: ")) {
    return {
      name: normalizeDecoratedRefName(rawName.slice(5), "tag"),
      kind: "tag",
      isHead: false,
    };
  }

  const name = normalizeDecoratedRefName(rawName);
  if (name.length === 0) return null;
  if (name === "HEAD") return { name: "HEAD", kind: "head", isHead: true };

  return {
    name,
    kind: isDecoratedRemoteRef(rawName, name) ? "remote" : "branch",
    isHead: isHeadTarget,
  };
}

/**
 * Normalizes full Git refnames to the short names the renderer displays in
 * chips while leaving already-short `%D` names untouched.
 */
function normalizeDecoratedRefName(name: string, kind?: LogEntryRef["kind"]): string {
  const trimmed = name.trim();
  if (kind === "tag" && trimmed.startsWith("refs/tags/")) return trimmed.slice(10);
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice(11);
  if (trimmed.startsWith("refs/remotes/")) return trimmed.slice(13);
  if (trimmed.startsWith("refs/tags/")) return trimmed.slice(10);
  return trimmed;
}

/**
 * Classifies remote-tracking decorations. Full refs are exact; short refs need
 * a small heuristic because Git's default `%D` omits `refs/remotes/`.
 */
function isDecoratedRemoteRef(rawName: string, normalizedName: string): boolean {
  if (rawName.startsWith("refs/remotes/")) return true;
  const firstSegment = normalizedName.split("/", 1)[0];
  return firstSegment === "origin" || firstSegment === "upstream";
}
