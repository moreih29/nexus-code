/**
 * A workspace's repository as another device reads it (git.status,
 * git.diff, git.log, git.show): how its branch stands, the files it
 * changed, a changed file's diff, its commits and what one changed. Read
 * only. Paths are the repository's, relative to its top level, as git
 * gives them; a diff is given only of a file git says changed (in the
 * work tree, or in the commit asked about).
 */
import path from "node:path";
import {
  type DiffHunk,
  MAX_READ_BYTES,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { CommitDetail, DiffSpec, GitStatus, LogEntry } from "../../../shared/git/types";
import type { GitRepository } from "../git/domain/repository";
import { fitsInFrame, RpcFailure } from "./room";

/** What of a repository these read. */
export type RemoteRepository = Pick<
  GitRepository,
  "topLevel" | "status" | "diff" | "log" | "commitDetail"
>;

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

/** The empty tree's hash, what a root commit is compared with: SHA-1's, and SHA-256's. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

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

/** What git says of a commit; NotFound for one the repository does not have. */
async function commitIn(repository: RemoteRepository, hash: string): Promise<CommitDetail> {
  return repository.commitDetail(hash).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /bad object|bad revision|unknown revision|ambiguous argument|not a valid|invalid object/i.test(
        message,
      )
    ) {
      throw new RpcFailure(RpcErrorCode.NotFound, `no commit ${hash} in the repository`);
    }
    failed(error);
  });
}

/** A diff's hunks as a frame takes them: those after left out when they do not fit. */
function diffResult(
  head: { path: string; oldPath?: string },
  { hunks, binary, truncated }: { hunks: DiffHunk[]; binary: boolean; truncated: boolean },
): RpcResult<"git.diff"> {
  const result = { ...head, ...(binary ? { binary: true } : {}), hunks };
  if (!truncated && fits(result)) return result;
  let kept = hunks;
  while (kept.length > 0 && !fits({ ...result, hunks: kept })) kept = kept.slice(0, -1);
  return { ...result, hunks: kept, truncated: true };
}

/** A file's change in `spec`, its last hunk left out when the read cut it. */
async function specDiff(repository: RemoteRepository, spec: DiffSpec) {
  const { text, cut } = await diffText(repository, spec).catch(failed);
  const { hunks, binary } = hunksOf(text);
  // A hunk cut off in the middle by the read is left out whole.
  return cut
    ? { hunks: hunks.slice(0, -1), binary, truncated: true }
    : { hunks, binary, truncated: false };
}

/** A file's change in a commit, against the commit's first parent. */
async function commitDiff(
  repository: RemoteRepository,
  { path: asked, commit }: { path: string; commit: string },
): Promise<RpcResult<"git.diff">> {
  const detail = await commitIn(repository, commit);
  const file = detail.files.find((f) => f.path === asked);
  if (!file) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      `${asked} did not change in ${commit} (git.show lists what did)`,
    );
  }
  const head = { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) };
  const spec: DiffSpec = {
    kind: "ref-vs-ref",
    leftRef: detail.parents[0] ?? (detail.sha.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE),
    rightRef: detail.sha,
    relPath: file.path,
    ...(file.oldPath ? { oldRelPath: file.oldPath } : {}),
  };
  return diffResult(head, await specDiff(repository, spec));
}

export async function gitDiff(
  git: RemoteGit,
  { workspaceId, path: asked, staged = false, commit }: RpcParams<"git.diff">,
): Promise<RpcResult<"git.diff">> {
  if (commit !== undefined && staged) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "staged is not taken with commit");
  }
  const repository = await repositoryOf(git, workspaceId);
  if (commit !== undefined) return commitDiff(repository, { path: asked, commit });
  const status = await repository.status().catch(failed);
  const file = filesOf(status).find((f) => f.path === asked);
  if (!file || !(staged ? file.staged : file.unstaged)) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      `git sees no ${staged ? "staged" : "unstaged"} change to ${asked} (git.status lists them)`,
    );
  }
  const head = { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) };
  if (file.unstaged === "?" && !staged) {
    const text = await git
      .readUntracked(workspaceId, path.posix.join(repository.topLevel, file.path), MAX_READ_BYTES)
      .catch(failed);
    const binary = text.includes("\0");
    return diffResult(head, { hunks: binary ? [] : addedHunk(text), binary, truncated: false });
  }
  const pathShape = { relPath: file.path, ...(file.oldPath ? { oldRelPath: file.oldPath } : {}) };
  const spec: DiffSpec = staged
    ? { kind: "index-vs-head", ...pathShape }
    : { kind: "wt-vs-index", ...pathShape };
  return diffResult(head, await specDiff(repository, spec));
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

/** When `hash` was written, as git.log tells it (a rebased commit keeps it); null when not found. */
async function authoredAt(repository: RemoteRepository, hash: string): Promise<number | null> {
  const stream = repository.log({ ref: hash, limit: 1 });
  try {
    const next = await stream.next();
    const entry = next.done ? undefined : next.value.entries[0];
    return entry ? Date.parse(entry.authoredAt) || null : null;
  } catch {
    return null;
  } finally {
    await stream.return?.({ count: 0 }).catch(() => {});
  }
}

export async function gitShow(
  git: RemoteGit,
  { workspaceId, hash }: RpcParams<"git.show">,
): Promise<RpcResult<"git.show">> {
  const repository = await repositoryOf(git, workspaceId);
  const detail = await commitIn(repository, hash);
  const at = (await authoredAt(repository, detail.sha)) ?? (Date.parse(detail.committerTs) || 0);
  const body = detail.body.trim();
  const result: RpcResult<"git.show"> = {
    hash: detail.sha,
    parents: detail.parents,
    subject: detail.subject,
    ...(body ? { body } : {}),
    author: detail.author,
    at,
    files: detail.files.map((f) => ({
      path: f.path,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      status: f.status.charAt(0),
    })),
  };
  if (fits(result)) return result;
  // A commit of thousands of files: as many as go in a frame, the halves kept by halving.
  let { files } = result;
  while (files.length > 0 && !fits({ ...result, files }))
    files = files.slice(0, Math.floor(files.length / 2));
  return { ...result, files, truncated: true };
}
