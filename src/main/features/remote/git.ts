/**
 * A workspace's repository as another device reads it (git.status,
 * git.diff, git.log): how its branch stands, the files it changed, a
 * changed file's diff and its commits. Read only. Paths are the
 * repository's, relative to its top level, as git gives them; a diff is
 * given only of a file git says changed.
 */
import path from "node:path";
import {
  type DiffHunk,
  MAX_READ_BYTES,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { DiffSpec, GitStatus, LogEntry } from "../../../shared/git/types";
import type { GitRepository } from "../git/domain/repository";
import { fitsInFrame, RpcFailure } from "./room";

/** What of a repository these read. */
export type RemoteRepository = Pick<GitRepository, "topLevel" | "status" | "diff" | "log">;

export interface RemoteGit {
  /** The workspace's repository; null where it is none. */
  repository: (workspaceId: string) => Promise<RemoteRepository | null>;
  /** The start of a file git does not track yet, by its absolute path, for its diff: all of it added. */
  readUntracked: (workspaceId: string, absolute: string, maxBytes: number) => Promise<string>;
}

/** How many commits a log gives when it does not say. */
export const DEFAULT_LOG_COMMITS = 50;

/** Most bytes of a diff read before it is cut: a frame takes less anyway. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

type GitFile = RpcResult<"git.status">["files"][number];

const fits = (result: unknown) => fitsInFrame({ result, pad: "x".repeat(1024) });

function failed(error: unknown): never {
  if (error instanceof RpcFailure) throw error;
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

async function repositoryOf(git: RemoteGit, workspaceId: string): Promise<RemoteRepository> {
  const repository = await git.repository(workspaceId).catch(failed);
  if (!repository)
    throw new RpcFailure(RpcErrorCode.NotFound, "that workspace is no git repository");
  return repository;
}

const letter = (c: string | undefined) => (c && c !== " " ? c : undefined);

/** Each changed file once: what is staged of it, and what is not. */
export function filesOf(status: GitStatus): GitFile[] {
  const files = new Map<string, GitFile>();
  const fileOf = (relPath: string, oldRelPath?: string) => {
    const file = files.get(relPath) ?? {
      path: relPath,
      ...(oldRelPath ? { oldPath: oldRelPath } : {}),
    };
    files.set(relPath, file);
    return file;
  };
  for (const entry of status.merge) {
    const file = fileOf(entry.relPath, entry.oldRelPath);
    file.staged = letter(entry.xy[0]);
    file.unstaged = letter(entry.xy[1]);
  }
  for (const entry of status.staged) {
    const staged = letter(entry.xy[0]);
    if (staged) fileOf(entry.relPath, entry.oldRelPath).staged = staged;
  }
  for (const entry of status.working) {
    const unstaged = letter(entry.xy[1]);
    if (unstaged) fileOf(entry.relPath, entry.oldRelPath).unstaged = unstaged;
  }
  for (const entry of status.untracked) fileOf(entry.relPath).unstaged = "?";
  return [...files.values()].map((f) => ({
    path: f.path,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    ...(f.staged ? { staged: f.staged } : {}),
    ...(f.unstaged ? { unstaged: f.unstaged } : {}),
  }));
}

export async function gitStatus(
  git: RemoteGit,
  { workspaceId }: RpcParams<"git.status">,
): Promise<RpcResult<"git.status">> {
  const repository = await repositoryOf(git, workspaceId);
  const status = await repository.status().catch(failed);
  const result: RpcResult<"git.status"> = {
    branch: status.branch?.current ?? null,
    ...(status.branch?.upstream ? { upstream: status.branch.upstream } : {}),
    ahead: status.branch?.ahead ?? 0,
    behind: status.branch?.behind ?? 0,
    files: filesOf(status),
  };
  if (fits(result)) return result;
  // Thousands of changed files: as many as go in a frame, the halves kept by halving.
  let { files } = result;
  while (files.length > 0 && !fits({ ...result, files }))
    files = files.slice(0, Math.floor(files.length / 2));
  return { ...result, files, truncated: true };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A unified diff's hunks, and whether git called the file binary. */
export function hunksOf(diff: string): { hunks: DiffHunk[]; binary: boolean } {
  const hunks: DiffHunk[] = [];
  let binary = false;
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") binary = true;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) hunk.lines.push(line);
  }
  return { hunks, binary };
}

/** A new file's diff: every line added. */
export function addedHunk(text: string): DiffHunk[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return [];
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((l) => `+${l}`),
    },
  ];
}

async function diffText(
  repository: RemoteRepository,
  spec: DiffSpec,
): Promise<{ text: string; cut: boolean }> {
  let text = "";
  let cut = false;
  const stream = repository.diff(spec);
  while (true) {
    const next = await stream.next();
    if (next.done) {
      cut ||= next.value.truncated;
      break;
    }
    text += next.value.text;
    if (text.length > MAX_DIFF_BYTES) {
      cut = true;
      await stream.return?.({ bytes: text.length, truncated: true });
      break;
    }
  }
  return { text, cut };
}

export async function gitDiff(
  git: RemoteGit,
  { workspaceId, path: asked, staged = false }: RpcParams<"git.diff">,
): Promise<RpcResult<"git.diff">> {
  const repository = await repositoryOf(git, workspaceId);
  const status = await repository.status().catch(failed);
  const file = filesOf(status).find((f) => f.path === asked);
  if (!file || !(staged ? file.staged : file.unstaged)) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      `git sees no ${staged ? "staged" : "unstaged"} change to ${asked} (git.status lists them)`,
    );
  }
  const head = { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) };
  let hunks: DiffHunk[];
  let binary = false;
  let truncated = false;
  if (file.unstaged === "?" && !staged) {
    const text = await git
      .readUntracked(workspaceId, path.posix.join(repository.topLevel, file.path), MAX_READ_BYTES)
      .catch(failed);
    if (text.includes("\0")) binary = true;
    hunks = binary ? [] : addedHunk(text);
  } else {
    const pathShape = { relPath: file.path, ...(file.oldPath ? { oldRelPath: file.oldPath } : {}) };
    const spec: DiffSpec = staged
      ? { kind: "index-vs-head", ...pathShape }
      : { kind: "wt-vs-index", ...pathShape };
    const { text, cut } = await diffText(repository, spec).catch(failed);
    ({ hunks, binary } = hunksOf(text));
    // A hunk cut off in the middle by the read is left out whole.
    if (cut) {
      hunks = hunks.slice(0, -1);
      truncated = true;
    }
  }
  const result = { ...head, ...(binary ? { binary: true } : {}), hunks };
  if (!truncated && fits(result)) return result;
  while (hunks.length > 0 && !fits({ ...result, hunks })) hunks = hunks.slice(0, -1);
  return { ...result, hunks, truncated: true };
}

function commitOf(entry: LogEntry): RpcResult<"git.log">["commits"][number] {
  const refs = (entry.refs ?? []).map((r) => r.name);
  return {
    hash: entry.sha,
    subject: entry.subject,
    author: entry.authorName,
    at: Date.parse(entry.authoredAt) || 0,
    ...(refs.length > 0 ? { refs } : {}),
  };
}

export async function gitLog(
  git: RemoteGit,
  { workspaceId, limit = DEFAULT_LOG_COMMITS, skip = 0 }: RpcParams<"git.log">,
): Promise<RpcResult<"git.log">> {
  const repository = await repositoryOf(git, workspaceId);
  const commits: RpcResult<"git.log">["commits"] = [];
  const stream = repository.log({ limit, skip });
  try {
    while (commits.length < limit) {
      const next = await stream.next();
      if (next.done) break;
      commits.push(...next.value.entries.slice(0, limit - commits.length).map(commitOf));
    }
  } catch (error) {
    failed(error);
  } finally {
    await stream.return?.({ count: commits.length }).catch(() => {});
  }
  let shown = commits;
  while (shown.length > 0 && !fits({ commits: shown }))
    shown = shown.slice(0, Math.floor(shown.length / 2));
  return { commits: shown };
}
