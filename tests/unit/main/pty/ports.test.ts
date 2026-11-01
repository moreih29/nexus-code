/**
 * PortWatcher — when a workspace's listening ports are looked at: as its
 * terminals start printing after a quiet spell, once more as that settles,
 * then while they keep printing or it has ports, once when a terminal is
 * attached again, and not at all when it is quiet with none; and which
 * answers it shows.
 */
import { expect, test } from "bun:test";
import { PortWatcher } from "../../../../src/main/features/pty/ports";
import type { ListeningPort, WorkspacePorts } from "../../../../src/shared/pty/ports";

function host() {
  const listeners = new Map<string, (args: unknown) => void>();
  return {
    on(event: string, cb: (args: unknown) => void) {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
    emit(event: string, args: unknown) {
      listeners.get(event)?.(args);
    },
  };
}

const TIMING = { settleMs: 50, busyPollMs: 100, portsPollMs: 150 };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function port(n: number, tabId = "t"): ListeningPort {
  return { port: n, pid: n * 10, process: "node", tabId };
}

/** A watcher whose looks answer `answers` in turn, the last one again and again, after `delayMs`. */
function setup(answers: Array<ListeningPort[] | Error>, delayMs = 0) {
  const source = host();
  let now = 1_000;
  const looked: string[] = [];
  const changes: WorkspacePorts[] = [];
  const watcher = new PortWatcher(
    source,
    async (workspaceId) => {
      looked.push(workspaceId);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (delayMs > 0) await wait(delayMs);
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    (entry) => changes.push(entry),
    () => now,
    TIMING,
  );
  return {
    source,
    watcher,
    looked,
    changes,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("output after a quiet spell is looked at at once and again as it settles", async () => {
  const { source, watcher, looked, changes } = setup([[], [port(5173)], [port(5173)]]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "$ bun dev" });
  await wait(20);
  expect(looked).toEqual(["w"]);
  expect(watcher.get("w")).toEqual([]);

  await wait(70);
  expect(looked).toEqual(["w", "w"]);
  expect(watcher.get("w")).toEqual([port(5173)]);
  expect(changes).toEqual([{ workspaceId: "w", ports: [port(5173)] }]);
  expect(watcher.snapshot()).toEqual([{ workspaceId: "w", ports: [port(5173)] }]);
  watcher.dispose();
});

test("a quiet workspace with ports is looked at until its server stops, then left alone", async () => {
  const { source, watcher, looked, changes, advance } = setup([[port(8000)], [port(8000)], []]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "Serving on 8000" });
  advance(10_000); // the output is long past by the time the looks finish
  await wait(90);
  expect(looked).toHaveLength(2);
  expect(watcher.get("w")).toEqual([port(8000)]);

  // Quiet, with a port: looked at again after portsPollMs, which finds it stopped.
  await wait(170);
  expect(looked).toHaveLength(3);
  expect(watcher.get("w")).toEqual([]);
  expect(changes.at(-1)).toEqual({ workspaceId: "w", ports: [] });

  // Quiet with none: no more looks.
  await wait(250);
  expect(looked).toHaveLength(3);
  expect(watcher.snapshot()).toEqual([]);
  watcher.dispose();
});

test("a quiet workspace with no ports is not looked at", async () => {
  const { source, watcher, looked, advance } = setup([[]]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "$ ls" });
  advance(10_000);
  await wait(300);
  expect(looked).toHaveLength(2);
  watcher.dispose();
});

test("a terminal attached again is looked at once, for a server listening quietly", async () => {
  const { source, watcher, looked, changes } = setup([[port(8000)]]);

  // The replay comes in many chunks.
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "old", replay: true });
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "older", replay: true });
  await wait(20);
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "oldest", replay: true });
  await wait(20);
  expect(looked).toEqual(["w"]);
  expect(changes).toEqual([{ workspaceId: "w", ports: [port(8000)] }]);
  watcher.dispose();
});

test("a terminal's end takes its servers' ports with it", async () => {
  const { source, watcher, changes, advance } = setup([[port(3000, "a"), port(4000, "b")]]);

  source.emit("data", { workspaceId: "w", tabId: "a", chunk: "ready" });
  advance(10_000);
  await wait(20);
  expect(watcher.get("w")).toHaveLength(2);

  source.emit("exit", { workspaceId: "w", tabId: "a", code: 0 });
  expect(watcher.get("w")).toEqual([port(4000, "b")]);
  expect(changes.at(-1)).toEqual({ workspaceId: "w", ports: [port(4000, "b")] });
  watcher.dispose();
});

test("a held connection clears the workspace's ports and stops looking", async () => {
  const { source, watcher, looked, changes, advance } = setup([[port(3000)]]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "ready" });
  advance(10_000);
  await wait(90);
  const looks = looked.length;

  source.emit("held", { workspaceId: "w", tabId: "t" });
  expect(watcher.get("w")).toEqual([]);
  expect(changes.at(-1)).toEqual({ workspaceId: "w", ports: [] });
  await wait(250);
  expect(looked).toHaveLength(looks);
  watcher.dispose();
});

test("a failed look keeps the ports shown and looks again while output continues", async () => {
  const { source, watcher, looked, changes } = setup([
    [port(3000)],
    new Error("connection lost"),
    [port(3000), port(4000)],
  ]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "a" });
  await wait(20);
  expect(watcher.get("w")).toEqual([port(3000)]);

  // The settle look fails.
  await wait(60);
  expect(looked).toHaveLength(2);
  expect(watcher.get("w")).toEqual([port(3000)]);

  // The output is recent, so the busy poll comes anyway.
  await wait(120);
  expect(looked).toHaveLength(3);
  expect(watcher.get("w")).toEqual([port(3000), port(4000)]);
  expect(changes.map((c) => c.ports.length)).toEqual([1, 2]);
  watcher.dispose();
});

test("a look under way when a terminal ends does not bring its ports back", async () => {
  const { source, watcher, changes } = setup([[port(3000, "a")]], 40);

  source.emit("data", { workspaceId: "w", tabId: "a", chunk: "ready" });
  await wait(10);
  source.emit("exit", { workspaceId: "w", tabId: "a", code: 0 });
  await wait(50);
  expect(watcher.get("w")).toEqual([]);
  expect(changes).toEqual([]);
  watcher.dispose();
});

test("a look under way when the connection is held does not bring the ports back", async () => {
  const { source, watcher, changes } = setup([[port(3000)], [port(3000)]], 40);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "ready" });
  await wait(60);
  expect(watcher.get("w")).toEqual([port(3000)]);

  // The settle look starts at 90 ms; the connection drops while it runs.
  await wait(50);
  source.emit("held", { workspaceId: "w", tabId: "t" });
  await wait(60);
  expect(watcher.get("w")).toEqual([]);
  expect(changes).toEqual([
    { workspaceId: "w", ports: [port(3000)] },
    { workspaceId: "w", ports: [] },
  ]);
  watcher.dispose();
});
