// What a `claude -p` or `codex exec` run's own session holds, for the tab's
// pane to show the run as a conversation: a claude run's transcript, read on
// as it grows; a codex run's thread, read by an app-server started for the
// pane with the run's CODEX_HOME and closed with it. The renderer names the
// run only (workspace, tab, run id): main knows where its session is kept.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun } from "../../../shared/claude/activity";
import type { PrintRunTranscriptResult } from "../../../shared/ipc/contract";
import { ipcCallResult } from "../../ipc/client";
import { historyForDisplay, historyModel } from "./claude/history";
import { codexServerVersion, readCodexThread } from "./codex/history";
import { codexThreadModel, idKey } from "./codex/model";
import { type ChatLine, type ChatModel, rec, str } from "./model";
import { chatKey } from "./store";
import { addLineReceiver } from "./transport/receivers";

/** How often a running run's session is read again while its pane shows. */
export const RUN_READ_INTERVAL_MS = 3_000;
/** How many times a pane starts a reader again after one ended, and how long it waits to. */
export const RUN_READER_ATTEMPTS = 3;
export const RUN_READER_AGAIN_MS = 1_000;
/** How long a reader's answer is waited for. */
const READER_REQUEST_TIMEOUT_MS = 30_000;

/** A claude run's transcript as read so far. */
export interface RunLines {
  found: boolean;
  lines: readonly unknown[];
  /** Where the next read goes on from. */
  next: number;
  /** Lines before the first are not here: the file is past what one read takes. */
  truncated: boolean;
}

export const NO_RUN_LINES: RunLines = { found: false, lines: [], next: 0, truncated: false };

/** The lines with a read's: on from where they ended, or anew when the file was written over. */
export function mergeRunLines(prev: RunLines, read: PrintRunTranscriptResult): RunLines {
  // A read that finds none keeps what an earlier one found.
  if (!read.found) return prev;
  if (read.reset || !prev.found) {
    return { found: true, lines: read.lines, next: read.next, truncated: read.truncated };
  }
  if (read.lines.length === 0 && read.next === prev.next) return prev;
  return {
    found: true,
    lines: [...prev.lines, ...read.lines],
    next: read.next,
    truncated: prev.truncated || read.truncated,
  };
}

/** The thread a reader names in what it asks: none, as main fills in the reader's own. */
const MAINS_THREAD = "";

/** An app-server that reads one run's thread. */
export interface CodexRunReader {
  /** The thread as a conversation; null when it cannot be read whole, or the reader is gone. */
  read(): Promise<ChatModel | null>;
  /** Its program ended or cannot be told: it reads no more, and another is to be started. */
  readonly dead: boolean;
  close(): void;
}

/**
 * Starts the reader of the tab's `codex exec` run: null when the run has no
 * thread to read (it kept none, or it is not the tab's) or it did not start.
 */
export async function openCodexRunReader(
  workspaceId: string,
  tabId: string,
  runId: string,
  onDead?: () => void,
): Promise<CodexRunReader | null> {
  const started = await ipcCallResult("chat", "printRunReader", { workspaceId, tabId, runId });
  if (!started.ok || !started.value.ok) return null;
  const { readerTabId } = started.value;
  let nextId = 1;
  let closed = false;
  let dead = false;
  const waiting = new Map<
    string,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    for (const waiter of waiting.values()) waiter.reject(error);
    waiting.clear();
  };
  const die = (error: Error) => {
    fail(error);
    if (dead || closed) return;
    dead = true;
    onDead?.();
  };
  const off = addLineReceiver({
    key: chatKey(workspaceId, readerTabId),
    receive(line: ChatLine) {
      const message = rec(line.message);
      if (!message) return;
      if (line.dir === "sys") {
        if (message.event === "exit") die(new Error("the reader ended"));
        return;
      }
      if (line.dir !== "out") return;
      const key = idKey(message.id);
      const waiter = key ? waiting.get(key) : undefined;
      if (!key || !waiter) return;
      waiting.delete(key);
      const error = rec(message.error);
      if (error) waiter.reject(new Error(str(error.message) ?? "request failed"));
      else waiter.resolve(rec(message.result) ?? {});
    },
    held() {},
    async resync() {},
  });
  const write = async (message: Record<string, unknown>) => {
    const sent = await ipcCallResult("chat", "send", {
      workspaceId,
      tabId: readerTabId,
      message,
    });
    if (!sent.ok) {
      // Main knows no such reader, or its host is out of reach: it reads no more.
      const error = new Error(sent.message);
      die(error);
      throw error;
    }
  };
  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    const key = String(id);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(key);
        reject(new Error(`${method} timed out`));
      }, READER_REQUEST_TIMEOUT_MS);
      waiting.set(key, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      write({ id, method, params }).catch((error: Error) => {
        waiting.delete(key);
        clearTimeout(timer);
        reject(error);
      });
    });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    off();
    fail(new Error("the reader closed"));
    void ipcCallResult("chat", "close", { workspaceId, tabId: readerTabId });
  };
  try {
    const hello = await request("initialize", {
      clientInfo: { name: "nexus-code", title: "NexusCode", version: __APP_VERSION__ },
      capabilities: { experimentalApi: true },
    });
    await write({ method: "initialized" });
    const version = codexServerVersion(
      { appServerVersion: str(hello.userAgent)?.match(/^[^/]+\/([\d.]+)\b/)?.[1] },
      null,
    );
    // Main names the thread: the reader's own, which is all it reads.
    const read = (method: string, params: Record<string, unknown>) => {
      const { threadId: _mains, ...rest } = params;
      return request(method, rest);
    };
    let reading: Promise<ChatModel | null> | null = null;
    return {
      get dead() {
        return dead;
      },
      read() {
        if (closed || dead) return Promise.resolve(null);
        // One read at a time: a later ask shares the one going.
        reading ??= readCodexThread(read, MAINS_THREAD, version)
          // The conversation is named by the run: its thread is not told here.
          .then((thread) => (thread ? codexThreadModel({ id: runId, turns: thread.turns }) : null))
          .finally(() => {
            reading = null;
          });
        return reading;
      },
      close,
    };
  } catch {
    close();
    return null;
  }
}

/** A codex run's reader kept up for a pane: started again when it ends or did not start. */
export interface RunReaderKeeper {
  /** The thread by the reader now up; null with none up, or when it cannot be read. */
  read(): Promise<ChatModel | null>;
  close(): void;
}

/**
 * Keeps a reader of one run up. One whose program ended is closed and
 * another started, `RUN_READER_ATTEMPTS` times at most between reads that
 * gave the thread. One that did not start (its host is out of reach, or the
 * run has told no thread yet) is asked for again for as long as the run
 * goes on, and the same few times after it ended.
 */
export function keepRunReader(options: {
  open(onDead: () => void): Promise<CodexRunReader | null>;
  running(): boolean;
  /** A reader is up: its thread can be read. */
  onUp(): void;
  /** The clock, for a test's own. */
  timers?: { set(run: () => void, ms: number): unknown; clear(timer: unknown): void };
}): RunReaderKeeper {
  const timers = options.timers ?? {
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let reader: CodexRunReader | null = null;
  let closed = false;
  let opening = false;
  let attempts = 0;
  let timer: unknown;
  const again = (delay: number, counted: boolean) => {
    if (closed || timer !== undefined) return;
    if (counted) {
      if (attempts >= RUN_READER_ATTEMPTS) return;
      attempts += 1;
    }
    timer = timers.set(() => {
      timer = undefined;
      start();
    }, delay);
  };
  const start = () => {
    if (closed || opening || reader) return;
    opening = true;
    let mine: CodexRunReader | null = null;
    const onDead = () => {
      if (closed || !mine) return;
      if (reader === mine) reader = null;
      // Its program, its line receiver and main's record of it go.
      mine.close();
      again(RUN_READER_AGAIN_MS, true);
    };
    void options
      .open(onDead)
      .catch(() => null)
      .then((opened) => {
        opening = false;
        if (closed) {
          opened?.close();
          return;
        }
        if (!opened || opened.dead) {
          opened?.close();
          // Not reached is not ended: asked for again while the run goes on.
          const running = options.running();
          again(running ? RUN_READ_INTERVAL_MS : RUN_READER_AGAIN_MS, !running);
          return;
        }
        mine = opened;
        reader = opened;
        options.onUp();
      });
  };
  start();
  return {
    async read() {
      const model = (await reader?.read()) ?? null;
      if (model) attempts = 0;
      return model;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) timers.clear(timer);
      reader?.close();
      reader = null;
    },
  };
}

/**
 * The run's session as a conversation, read while the pane shows and again
 * as the run goes on; null until it is found, and for a run that keeps none
 * (the pane then shows what the run told the app).
 */
export function useRunConversation(
  workspaceId: string,
  tabId: string,
  run: AgentRun,
  visible: boolean,
): { model: ChatModel; truncated: boolean } | null {
  const runId = run.id;
  const codex = run.program === "codex";
  const running = run.end === undefined;
  // A run tells its session a moment after its start.
  const hasSession = run.sessionId !== undefined;
  const [lines, setLines] = useState<RunLines>(NO_RUN_LINES);
  const [thread, setThread] = useState<ChatModel | null>(null);
  const [tick, setTick] = useState(0);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // biome-ignore lint/correctness/useExhaustiveDependencies: another run starts anew
  useEffect(() => {
    setLines(NO_RUN_LINES);
    setThread(null);
  }, [workspaceId, tabId, runId]);

  useEffect(() => {
    if (!visible || !running) return;
    const timer = setInterval(() => setTick((n) => n + 1), RUN_READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [visible, running]);

  // A claude run's transcript: on from the last read, and once more as it ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and running ask for another read
  useEffect(() => {
    if (codex || !visible || !hasSession) return;
    let stale = false;
    const prev = linesRef.current;
    void ipcCallResult("chat", "printRunTranscript", {
      workspaceId,
      tabId,
      runId,
      ...(prev.found ? { from: prev.next } : {}),
    }).then((result) => {
      if (stale || !result.ok || linesRef.current !== prev) return;
      setLines(mergeRunLines(prev, result.value));
    });
    return () => {
      stale = true;
    };
  }, [codex, visible, hasSession, workspaceId, tabId, runId, tick, running]);

  // A codex run's thread: a reader for as long as the pane shows it.
  const keeper = useRef<RunReaderKeeper | null>(null);
  const [readerUp, setReaderUp] = useState(0);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (!codex || !visible || !hasSession) return;
    const kept = keepRunReader({
      open: (onDead) => openCodexRunReader(workspaceId, tabId, runId, onDead),
      running: () => runningRef.current,
      onUp: () => setReaderUp((n) => n + 1),
    });
    keeper.current = kept;
    return () => {
      kept.close();
      if (keeper.current === kept) keeper.current = null;
    };
  }, [codex, visible, hasSession, workspaceId, tabId, runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and running ask for another read
  useEffect(() => {
    const current = keeper.current;
    if (!current) return;
    let stale = false;
    void current
      .read()
      .then((model) => {
        if (!stale && model) setThread(model);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [readerUp, tick, running]);

  const transcript = useMemo(() => {
    if (!lines.found || lines.lines.length === 0) return null;
    const model = historyModel(lines.lines);
    // A call with no result yet still runs only while the run does.
    return running ? model : historyForDisplay(model);
  }, [lines, running]);

  return useMemo(() => {
    const model = codex ? thread : transcript;
    if (!model || model.items.length === 0) return null;
    return { model, truncated: !codex && lines.truncated };
  }, [codex, thread, transcript, lines.truncated]);
}
