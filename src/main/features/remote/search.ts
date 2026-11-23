import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { AgentSearchFilesResultSchema, SEARCH_FILES_METHOD } from "../../../shared/search/protocol";
import { type FileMatch, TextSearchQuerySchema } from "../../../shared/search/types";
import {
  type AgentBackedProvider,
  type FsProvider,
  isAgentBackedProvider,
} from "../fs/bridge/provider";
import { createAgentSearchSession } from "../search/session";
import { fitsInFrame, RpcFailure } from "./room";

export const DEFAULT_FIND_RESULTS = 50;

export const DEFAULT_SEARCH_MATCHES = 200;

export const SEARCH_TIME_MS = 15_000;

const fits = (result: unknown) => fitsInFrame({ result, pad: "x".repeat(1024) });

function unavailable(error: unknown): never {
  if (error instanceof RpcFailure) throw error;
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

function agentOf(fs: FsProvider): AgentBackedProvider {
  if (!isAgentBackedProvider(fs)) {
    throw new RpcFailure(RpcErrorCode.Unavailable, "the workspace's agent is not running");
  }
  return fs;
}

function fitted<T>(items: T[], resultOf: (items: T[]) => unknown): { items: T[]; cut: boolean } {
  let kept = items;
  while (kept.length > 0 && !fits(resultOf(kept)))
    kept = kept.slice(0, Math.floor(kept.length / 2));
  return { items: kept, cut: kept.length < items.length };
}

export async function findFiles(
  fs: FsProvider,
  { query, limit = DEFAULT_FIND_RESULTS }: RpcParams<"files.find">,
): Promise<RpcResult<"files.find">> {
  const agent = agentOf(fs);
  const found = AgentSearchFilesResultSchema.parse(
    await agent.callAgentMethod(SEARCH_FILES_METHOD, { query, limit }).catch(unavailable),
  );
  const { items: files, cut } = fitted(found.files.slice(0, limit), (files) => ({ files }));
  return { files, ...(found.truncated || cut ? { truncated: true } : {}) };
}

type SearchedFile = RpcResult<"files.search">["files"][number];

function searchedOf(file: FileMatch): SearchedFile {
  return {
    path: file.relPath,
    matches: file.matches.map(({ range, preview, previewStart }) => ({
      line: range.line + 1,
      column: range.startCol,
      length: Math.max(0, range.endCol - range.startCol),
      text: preview,
      ...(previewStart ? { textStart: previewStart } : {}),
    })),
  };
}

export async function searchFiles(
  fs: FsProvider,
  params: RpcParams<"files.search">,
  timeMs = SEARCH_TIME_MS,
): Promise<RpcResult<"files.search">> {
  const agent = agentOf(fs);
  const limit = params.limit ?? DEFAULT_SEARCH_MATCHES;
  const query = TextSearchQuerySchema.parse({
    pattern: params.query,
    isRegExp: params.regex ?? false,
    isCaseSensitive: params.caseSensitive ?? false,
    isWordMatch: params.wholeWord ?? false,
    includes: params.include ?? [],
    excludes: params.exclude ?? [],
    maxResults: limit + 1,
  });
  const found: FileMatch[] = [];
  let matches = 0;
  let enough: () => void = () => {};
  const enoughFound = new Promise<"enough">((resolve) => {
    enough = () => resolve("enough");
  });
  const session = createAgentSearchSession(agent, (batch) => {
    for (const file of batch) {
      found.push(file);
      matches += file.matches.length;
    }
    if (matches > limit) enough();
  });
  const complete = session.start(query, { timeoutMs: timeMs + 5_000 });
  complete.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<"time">((resolve) => {
    timer = setTimeout(() => resolve("time"), timeMs);
  });
  let ended: Awaited<typeof complete> | "enough" | "time";
  try {
    ended = await Promise.race([complete, enoughFound, outOfTime]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid search pattern")) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, error.message);
    }
    unavailable(error);
  } finally {
    clearTimeout(timer);
    session.dispose();
  }

  const files: SearchedFile[] = [];
  let left = limit;
  for (const file of found) {
    if (left === 0) break;
    const searched = searchedOf(file);
    searched.matches = searched.matches.slice(0, left);
    left -= searched.matches.length;
    files.push(searched);
  }
  const { items, cut } = fitted(files, (files) => ({ files }));
  return {
    files: items,
    ...(matches > limit || ended === "time" || cut ? { truncated: true } : {}),
  };
}
