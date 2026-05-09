import fs from "node:fs";
import path from "node:path";
import {
  BINARY_DETECTION_BYTES,
  HIDDEN_NAMES,
  SEARCH_DEFAULT_EXCLUDES,
} from "../../shared/fs-defaults";
import type { FileMatch, TextSearchQuery } from "../../shared/types/search";
import { isBinaryProbe } from "../filesystem/binary-detect";
import { compileSearchRegExp, findMatchesInBuffer } from "./matcher";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WalkerOptions {
  onBatch: (batch: FileMatch[]) => void;
  signal: AbortSignal;
}

export interface WalkerResult {
  filesScanned: number;
  matchesFound: number;
  limitHit: boolean;
}

// ---------------------------------------------------------------------------
// Exclusion / inclusion predicate builders
// ---------------------------------------------------------------------------

interface ExcludePredicate {
  matchesDir: (name: string) => boolean;
  matchesFile: (name: string) => boolean;
}

function buildExcludePredicates(patterns: readonly string[]): ExcludePredicate {
  const dirNames: string[] = [];
  const extSuffixes: string[] = [];
  const exactNames: string[] = [];

  for (const pat of patterns) {
    if (pat.endsWith("/")) {
      dirNames.push(pat.slice(0, -1));
    } else if (pat.startsWith("*.")) {
      extSuffixes.push(pat.slice(1)); // e.g. ".min.js"
    } else {
      exactNames.push(pat);
    }
  }

  return {
    matchesDir: (name: string) => dirNames.includes(name),
    matchesFile: (name: string) => {
      if (exactNames.includes(name)) return true;
      for (const suffix of extSuffixes) {
        if (name.endsWith(suffix)) return true;
      }
      return false;
    },
  };
}

function buildIncludePredicate(patterns: readonly string[]): ((name: string) => boolean) | null {
  if (patterns.length === 0) return null;

  const extSuffixes: string[] = [];
  const exactNames: string[] = [];

  for (const pat of patterns) {
    if (pat.startsWith("*.")) {
      extSuffixes.push(pat.slice(1));
    } else {
      exactNames.push(pat);
    }
  }

  return (name: string) => {
    if (exactNames.includes(name)) return true;
    for (const suffix of extSuffixes) {
      if (name.endsWith(suffix)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Batch state
// ---------------------------------------------------------------------------

interface BatchState {
  pending: FileMatch[];
  matchesFound: number;
  matchesSinceFlush: number;
  lastFlushAt: number;
  limitHit: boolean;
}

const BATCH_COUNT_TRIGGER = 50;
const BATCH_MATCHES_TRIGGER = 200;
const BATCH_MS_TRIGGER = 30;
const PER_FILE_MATCH_CAP = 1000;

function shouldFlush(state: BatchState): boolean {
  return (
    state.pending.length >= BATCH_COUNT_TRIGGER ||
    state.matchesSinceFlush >= BATCH_MATCHES_TRIGGER ||
    Date.now() - state.lastFlushAt >= BATCH_MS_TRIGGER
  );
}

function takeBatch(state: BatchState): FileMatch[] | undefined {
  if (state.pending.length === 0) return undefined;
  const batch = state.pending.splice(0);
  state.matchesSinceFlush = 0;
  state.lastFlushAt = Date.now();
  return batch;
}

function maybeTakeBatch(state: BatchState): FileMatch[] | undefined {
  if (!shouldFlush(state)) return undefined;
  return takeBatch(state);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

// ---------------------------------------------------------------------------
// Read a file for search: probe first 512 B, then read the rest only if needed
// ---------------------------------------------------------------------------

/**
 * Returns the file Buffer if the file looks textual, or null if it is binary.
 * Opens exactly one file descriptor and always closes it.
 */
async function readForSearch(absPath: string, fileSize: number): Promise<Buffer | null> {
  const probeLen = Math.min(fileSize, BINARY_DETECTION_BYTES);
  const probeBuf = Buffer.allocUnsafe(probeLen);
  const fh = await fs.promises.open(absPath, "r");
  try {
    const { bytesRead } = await fh.read(probeBuf, 0, probeLen, 0);
    const probe = probeBuf.subarray(0, bytesRead);
    if (isBinaryProbe(probe)) return null;

    // When the whole file fits in the probe window we already have all bytes.
    if (fileSize <= BINARY_DETECTION_BYTES) return probe;

    // Need the rest — close fd and do a single readFile (simpler than partial reads).
    await fh.close();
    // Mark fd as closed so finally doesn't attempt another close.
    return await fs.promises.readFile(absPath);
  } finally {
    // close() is idempotent on FileHandle — second call throws EBADF which we swallow.
    try {
      await fh.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// walkAndSearch
// ---------------------------------------------------------------------------

/**
 * Drain the search iterator into the caller's `onBatch` sink and return
 * the final summary. Wraps `walkAndSearchIter` so callers that just want
 * "stream-as-you-find" semantics don't need to write the iteration loop
 * themselves; the iterator form remains exported for callers that want
 * back-pressure or cancellation between batches.
 */
export async function walkAndSearch(
  rootAbs: string,
  query: TextSearchQuery,
  opts: WalkerOptions,
): Promise<WalkerResult> {
  const iterator = walkAndSearchIter(rootAbs, query, opts.signal);

  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    opts.onBatch(next.value);
  }
}

export async function* walkAndSearchIter(
  rootAbs: string,
  query: TextSearchQuery,
  signal: AbortSignal,
): AsyncGenerator<FileMatch[], WalkerResult, unknown> {
  // Throws InvalidSearchPatternError synchronously if pattern is bad.
  const regex = compileSearchRegExp(query);

  const defaultExclude = buildExcludePredicates(SEARCH_DEFAULT_EXCLUDES);
  const userExclude = buildExcludePredicates(query.excludes);
  const includePredicate = buildIncludePredicate(query.includes);

  const state: BatchState = {
    pending: [],
    matchesFound: 0,
    matchesSinceFlush: 0,
    lastFlushAt: Date.now(),
    limitHit: false,
  };

  let filesScanned = 0;

  async function* recurse(dirAbs: string): AsyncGenerator<FileMatch[], void, unknown> {
    throwIfAborted(signal);

    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(dirAbs, { bufferSize: 64 });
    } catch {
      // EACCES or similar on the directory itself — skip silently.
      return;
    }

    try {
      for await (const dirent of dir) {
        throwIfAborted(signal);

        const name = dirent.name;

        if (dirent.isDirectory()) {
          if (HIDDEN_NAMES.has(name)) continue;
          if (defaultExclude.matchesDir(name) || userExclude.matchesDir(name)) continue;
          yield* recurse(path.join(dirAbs, name));
          if (state.limitHit) return;
          continue;
        }

        if (!dirent.isFile()) continue; // skip symlinks, sockets, etc.

        if (defaultExclude.matchesFile(name) || userExclude.matchesFile(name)) continue;
        if (includePredicate !== null && !includePredicate(name)) continue;

        const absPath = path.join(dirAbs, name);

        try {
          const stat = await fs.promises.stat(absPath);
          if (stat.size === 0 || stat.size > query.maxFileSize) continue;

          const buf = await readForSearch(absPath, stat.size);
          if (buf === null) continue; // binary

          // Count every file whose content is inspected by the matcher,
          // regardless of whether it yields matches. Excluded / binary /
          // oversize / empty files are not counted.
          filesScanned++;

          const relPath = path.relative(rootAbs, absPath);
          const fileMatches = findMatchesInBuffer(buf, regex, PER_FILE_MATCH_CAP);
          if (fileMatches.length === 0) continue;

          state.matchesFound += fileMatches.length;
          state.matchesSinceFlush += fileMatches.length;
          state.pending.push({ relPath, matches: fileMatches });

          if (state.matchesFound >= query.maxResults) {
            state.limitHit = true;
            const batch = takeBatch(state);
            if (batch) yield batch;
            return;
          }

          const batch = maybeTakeBatch(state);
          if (batch) yield batch;
        } catch (err) {
          if (isAbortError(err)) throw err;
          // EACCES, ENOENT race, etc. — log and continue.
          console.warn(`[search] skipping ${absPath}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn(`[search] error iterating ${dirAbs}: ${(err as Error).message}`);
    }
  }

  yield* recurse(rootAbs);
  throwIfAborted(signal);

  const batch = takeBatch(state);
  if (batch) yield batch;
  return { filesScanned, matchesFound: state.matchesFound, limitHit: state.limitHit };
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
