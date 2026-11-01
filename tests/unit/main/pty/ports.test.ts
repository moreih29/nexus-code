/**
 * PortWatcher — when a workspace's listening ports are looked at: as its
 * terminals start printing after a quiet spell, once more as that settles,
 * then while they keep printing or it has ports, and not at all when it is
 * quiet with none.
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

function setup(answers: Array<ListeningPort[] | Error>) {
  const source = host();
  let now = 1_000;
  const looked: string[] = [];
  const changes: WorkspacePorts[] = [];
  const watcher = new PortWatcher(
    source,
    async (workspaceId) => {
      looked.push(workspaceId);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
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

test("replayed output is not looked at", async () => {
  const { source, watcher, looked } = setup([[]]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "old", replay: true });
  await wait(80);
  expect(looked).toEqual([]);
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

test("a failed look waits for output after a quiet spell", async () => {
  const { source, watcher, looked, advance } = setup([new Error("unsupported method")]);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "a" });
  await wait(100);
  expect(looked).toHaveLength(2);

  // Output that keeps coming does not ask again and again.
  advance(500);
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "b" });
  await wait(200);
  expect(looked).toHaveLength(2);

  // Output after a quiet spell tries again.
  advance(5_000);
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "c" });
  await wait(20);
  expect(looked).toHaveLength(3);
  watcher.dispose();
});
