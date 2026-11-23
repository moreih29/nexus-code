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

export const RUN_READ_INTERVAL_MS = 3_000;
export const RUN_READER_ATTEMPTS = 3;
export const RUN_READER_AGAIN_MS = 1_000;
const READER_REQUEST_TIMEOUT_MS = 30_000;

export interface RunLines {
  found: boolean;
  lines: readonly unknown[];
  next: number;
  truncated: boolean;
}

export const NO_RUN_LINES: RunLines = { found: false, lines: [], next: 0, truncated: false };

export function mergeRunLines(prev: RunLines, read: PrintRunTranscriptResult): RunLines {
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

const MAINS_THREAD = "";

export interface CodexRunReader {
  read(): Promise<ChatModel | null>;
  readonly dead: boolean;
  close(): void;
}

export type RunReaderMiss = "none" | "failed";

export async function openCodexRunReader(
  workspaceId: string,
  tabId: string,
  runId: string,
  onDead?: () => void,
): Promise<CodexRunReader | RunReaderMiss> {
  const started = await ipcCallResult("chat", "printRunReader", { workspaceId, tabId, runId });
  if (!started.ok) return "failed";
  if (!started.value.ok) return started.value.reason === "none" ? "none" : "failed";
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
        reading ??= readCodexThread(read, MAINS_THREAD, version)
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
    return "failed";
  }
}

export interface RunReaderKeeper {
  read(): Promise<ChatModel | null>;
  close(): void;
}

export function keepRunReader(options: {
  open(onDead: () => void): Promise<CodexRunReader | RunReaderMiss>;
  running(): boolean;
  onUp(): void;
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
      mine.close();
      again(RUN_READER_AGAIN_MS, true);
    };
    void options
      .open(onDead)
      .catch((): RunReaderMiss => "failed")
      .then((opened) => {
        opening = false;
        if (typeof opened === "string") {
          const waited = opened === "none" && options.running();
          again(waited ? RUN_READ_INTERVAL_MS : RUN_READER_AGAIN_MS, !waited);
          return;
        }
        if (closed) {
          opened.close();
          return;
        }
        if (opened.dead) {
          opened.close();
          again(RUN_READER_AGAIN_MS, true);
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

export function useRunConversation(
  workspaceId: string,
  tabId: string,
  run: AgentRun,
  visible: boolean,
): { model: ChatModel; truncated: boolean } | null {
  const runId = run.id;
  const codex = run.program === "codex";
  const running = run.end === undefined;
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
    return running ? model : historyForDisplay(model);
  }, [lines, running]);

  return useMemo(() => {
    const model = codex ? thread : transcript;
    if (!model || model.items.length === 0) return null;
    return { model, truncated: !codex && lines.truncated };
  }, [codex, thread, transcript, lines.truncated]);
}
