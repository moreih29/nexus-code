import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import { snapshotSessions } from "../../../../../src/main/features/remote/serving/sessions";

import { testSessionsRevision } from "../../../../helpers/sessions-snapshot";

type Unread = Record<string, Record<string, number>>;

function host() {
  let revision = 10;
  let unread: Unread | undefined = { w1: { t1: 50, t2: 70 } };
  let snapshotGate: Promise<void> | undefined;
  let markSeenGate: Promise<void> | undefined;
  let markSeenFails = false;
  let markSeenTimeout: Promise<never> | undefined;
  let reads = 0;
  const services = {
    listWorkspaces: () => [{ id: "w1", name: "w1", rootPath: "/w1" }],
    claudeStatus: () => null,
    activity: () => null,
    claudeAsks: () => [],
    claudeAgents: { list: () => [] },
    consents: { list: () => [], listResolutions: () => [] },
    ui: async (
      op: string,
      args: { seen?: { workspaceId: string; tabId: string; upTo: number }[] },
    ) => {
      if (op === "sessions.snapshot") {
        reads++;
        const at = revision;
        const map = unread && structuredClone(unread);
        await snapshotGate;
        return {
          revision: at,
          workspaces: [
            {
              tabs: ["t1", "t2"].map((id) => ({
                id,
                type: "claude",
                title: id,
                chat: { state: "idle", since: 1 },
              })),
            },
          ],
          ...(map ? { unread: map } : {}),
        };
      }
      if (op === "sessions.markSeen") {
        const fails = markSeenFails;
        markSeenFails = false;
        const apply = async () => {
          await markSeenGate;
          if (fails) throw new Error("the window did not answer");
          let marked = 0;
          for (const { workspaceId, tabId, upTo } of args.seen ?? []) {
            const since = unread?.[workspaceId]?.[tabId];
            if (since === undefined || since > upTo) continue;
            delete unread?.[workspaceId]?.[tabId];
            marked++;
          }
          revision++;
          return { marked };
        };
        return markSeenTimeout ? Promise.race([apply(), markSeenTimeout]) : apply();
      }
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as CliServices;
  const revisions = testSessionsRevision((args, timeoutMs) =>
    services.ui("sessions.snapshot", args, timeoutMs),
  );
  const withRevisions = { ...services, sessionsRevision: revisions };
  const serve = serveWith(() => withRevisions);
  return {
    services: withRevisions,
    reads: () => reads,
    markSeen: (tabId: string, upTo: number, from = "phone") =>
      serve({
        from,
        method: "sessions.markSeen",
        params: { seen: [{ workspaceId: "w1", tabId, upTo }] },
      }),
    told: () => revisions.saw(revision),
    holdSnapshot() {
      const gate = Promise.withResolvers<void>();
      snapshotGate = gate.promise;
      return () => {
        snapshotGate = undefined;
        gate.resolve();
      };
    },
    holdMarkSeen() {
      const gate = Promise.withResolvers<void>();
      markSeenGate = gate.promise;
      return () => {
        markSeenGate = undefined;
        gate.resolve();
      };
    },
    failMarkSeen: () => {
      markSeenFails = true;
    },
    timeOutMarkSeen: () => {
      const timeout = Promise.withResolvers<never>();
      markSeenTimeout = timeout.promise;
      return () => timeout.reject(new Error("NexusCode's window did not answer"));
    },
    setUnread: (next: Unread | undefined) => {
      unread = next;
    },
  };
}

const states = async (services: CliServices) =>
  Object.fromEntries(
    (await snapshotSessions(services, undefined)).list.sessions.map((row) => [
      row.tabId,
      row.state,
    ]),
  );

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a list read before a receipt and made after it leaves the result read", async () => {
  const app = host();
  const release = app.holdSnapshot();
  const list = states(app.services);
  expect(await app.markSeen("t1", 50)).toEqual({ marked: 1 });
  release();
  expect(await list).toEqual({ t1: "idle", t2: "new-result" });
});

test("a list made while the renderer takes a receipt leaves the result read", async () => {
  const app = host();
  const release = app.holdMarkSeen();
  const marking = app.markSeen("t1", 50);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  release();
  await marking;
});

test("a reused read leaves the result read before the renderer tells of the change", async () => {
  const app = host();
  expect(await states(app.services)).toEqual({ t1: "new-result", t2: "new-result" });
  await app.markSeen("t1", 50);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  expect(app.reads()).toBe(1);
  app.told();
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  expect(app.reads()).toBe(2);
});

test("the unread map kept when a read fails leaves the result read", async () => {
  const app = host();
  await states(app.services);
  await app.markSeen("t1", 50);
  app.told();
  app.setUnread(undefined);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  expect(app.reads()).toBe(2);
});

test("a receipt covers only up to its time, and a map read after the renderer took it", async () => {
  const app = host();
  const release = app.holdSnapshot();
  const list = states(app.services);
  await app.markSeen("t1", 49);
  release();
  expect(await list).toEqual({ t1: "new-result", t2: "new-result" });
  await app.markSeen("t2", 70);
  jest.advanceTimersByTime(1);
  app.told();
  app.setUnread({ w1: { t2: 70 } });
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
});

test("a receipt the renderer did not take leaves the result as it is", async () => {
  const app = host();
  const release = app.holdSnapshot();
  const list = states(app.services);
  app.failMarkSeen();
  await expect(app.markSeen("t1", 50)).rejects.toThrow();
  release();
  expect(await list).toEqual({ t1: "new-result", t2: "new-result" });
});

test("a receipt counts for a while only", async () => {
  const app = host();
  await states(app.services);
  await app.markSeen("t1", 50);
  app.told();
  app.setUnread(undefined);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  jest.advanceTimersByTime(30_000);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "idle" });
});

test("one device's failed receipt leaves the other device's receipt in place", async () => {
  const app = host();
  await states(app.services);
  const release = app.holdMarkSeen();
  const first = app.markSeen("t1", 50, "phone-1");
  app.failMarkSeen();
  const second = app.markSeen("t1", 80, "phone-2");
  const secondFailed = second.catch((error) => error);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  release();
  expect(await first).toEqual({ marked: 1 });
  expect(await secondFailed).toBeInstanceOf(Error);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  expect(app.reads()).toBe(1);
});

test("a renderer that takes a timed-out receipt still clears the result on its next read", async () => {
  const app = host();
  const release = app.holdMarkSeen();
  const expire = app.timeOutMarkSeen();
  const marking = app.markSeen("t1", 50);
  const failed = marking.catch((error) => error);
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
  jest.advanceTimersByTime(15_000);
  expire();
  expect(await failed).toBeInstanceOf(Error);
  expect(await states(app.services)).toEqual({ t1: "new-result", t2: "new-result" });
  release();
  await Promise.resolve();
  app.told();
  expect(await states(app.services)).toEqual({ t1: "idle", t2: "new-result" });
});
