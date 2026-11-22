/**
 * The sessions' list reads the renderer again only when the renderer tells
 * a change (its revision), and at least every SESSIONS_REREAD_MS.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { SessionsUpdate } from "../../../../../packages/remote-protocol/src";
import type { CliServices, SessionsRevision } from "../../../../../src/main/features/cli/context";
import {
  SESSIONS_REREAD_MS,
  snapshotSessions,
} from "../../../../../src/main/features/remote/serving/sessions";
import { SessionWatches } from "../../../../../src/main/features/remote/session-watches";

/** The renderer: its sessions as they are now, and its count of changes. */
function renderer() {
  let revision = 100;
  let title = "first";
  let chatReadable = true;
  let unreadReadable = true;
  let workspaceIds = ["w1"];
  const reads: string[][] = [];
  let latest: number | undefined;
  const revisions: SessionsRevision = {
    latest: () => latest,
    saw: (seen) => {
      if (latest === undefined || seen > latest) latest = seen;
    },
  };
  const services = {
    listWorkspaces: () => workspaceIds.map((id) => ({ id, name: id, rootPath: `/${id}` })),
    claudeStatus: () => null,
    activity: () => null,
    claudeAsks: () => [],
    claudeAgents: { list: () => [] },
    consents: { list: () => [] },
    sessionsRevision: revisions,
    ui: async (op: string, args: { workspaceIds: string[] }) => {
      if (op !== "sessions.snapshot") throw new Error(`unexpected ${op}`);
      reads.push(args.workspaceIds);
      return {
        revision,
        workspaces: args.workspaceIds.map(() => ({
          tabs: [
            {
              id: "t1",
              type: "claude",
              title,
              ...(chatReadable ? { chat: { state: "idle", since: 1 } } : {}),
            },
          ],
        })),
        ...(unreadReadable ? { unread: {} } : {}),
      };
    },
  } as unknown as CliServices;
  return {
    services,
    reads,
    /** The renderer changes and tells main, as cli.sessionsChanged does. */
    change(next: string) {
      title = next;
      revision++;
      revisions.saw(revision);
    },
    /** The renderer changes without telling main: the next read finds out. */
    changeUntold(next: string) {
      title = next;
      revision++;
    },
    chatReadable(value: boolean) {
      chatReadable = value;
    },
    unreadReadable(value: boolean) {
      unreadReadable = value;
    },
    workspaces(ids: string[]) {
      workspaceIds = ids;
    },
  };
}

const titles = async (services: CliServices) =>
  (await snapshotSessions(services, undefined)).list.sessions.map((row) => row.title);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("reading the renderer for the sessions' list", () => {
  test("no change asks nothing; a told change asks once; ten seconds asks again", async () => {
    const app = renderer();
    expect(await titles(app.services)).toEqual(["first"]);
    expect(app.reads).toHaveLength(1);
    expect(await titles(app.services)).toEqual(["first"]);
    expect(await titles(app.services)).toEqual(["first"]);
    expect(app.reads).toHaveLength(1);

    app.change("second");
    expect(await titles(app.services)).toEqual(["second"]);
    expect(await titles(app.services)).toEqual(["second"]);
    expect(app.reads).toHaveLength(2);

    // A change the renderer did not tell is in the list within SESSIONS_REREAD_MS.
    app.changeUntold("third");
    jest.advanceTimersByTime(SESSIONS_REREAD_MS - 1);
    expect(await titles(app.services)).toEqual(["second"]);
    jest.advanceTimersByTime(1);
    expect(await titles(app.services)).toEqual(["third"]);
    expect(app.reads).toHaveLength(3);
    expect(await titles(app.services)).toEqual(["third"]);
    expect(app.reads).toHaveLength(3);
  });

  test("an answer at a newer revision than told stands for it", async () => {
    const app = renderer();
    await titles(app.services);
    app.change("second");
    // Changed again before main read: the renderer told only the first change.
    app.changeUntold("third");
    expect(await titles(app.services)).toEqual(["third"]);
    expect(await titles(app.services)).toEqual(["third"]);
    expect(app.reads).toHaveLength(2);
  });

  test("a read missing a chat or the unread map is asked again", async () => {
    const app = renderer();
    app.chatReadable(false);
    await titles(app.services);
    await titles(app.services);
    expect(app.reads).toHaveLength(2);
    app.chatReadable(true);
    app.unreadReadable(false);
    await titles(app.services);
    await titles(app.services);
    expect(app.reads).toHaveLength(4);
    app.unreadReadable(true);
    await titles(app.services);
    await titles(app.services);
    expect(app.reads).toHaveLength(5);
  });

  test("another set of workspaces is read again", async () => {
    const app = renderer();
    await titles(app.services);
    app.workspaces(["w1", "w2"]);
    expect(await titles(app.services)).toEqual(["first", "first"]);
    expect(app.reads).toEqual([["w1"], ["w1", "w2"]]);
  });

  test("a services object made from the app's shares its reads", async () => {
    const app = renderer();
    await titles(app.services);
    // As serve.ts wraps the services for one request.
    await titles({ ...app.services, ui: app.services.ui });
    expect(app.reads).toHaveLength(1);
  });

  test("without a revision, every list reads the renderer", async () => {
    const app = renderer();
    const { sessionsRevision: _, ...services } = app.services;
    await titles(services as CliServices);
    await titles(services as CliServices);
    expect(app.reads).toHaveLength(2);
  });
});

describe("a watched sessions' list", () => {
  test("polls without a change ask the renderer nothing and send nothing; one change, one read and one update", async () => {
    const app = renderer();
    const sent: SessionsUpdate[] = [];
    const watches = new SessionWatches({
      snapshot: async () => {
        const snapshot = await snapshotSessions(app.services, undefined);
        return { ...snapshot, forDevice: async () => snapshot.list };
      },
      notify: async (_to, update) => {
        sent.push(update);
        return true;
      },
      pollMs: 60_000,
    });
    try {
      await watches.watch("phone");
      expect(app.reads).toHaveLength(1);
      for (let i = 0; i < 5; i++) await watches.poll();
      expect(app.reads).toHaveLength(1);
      expect(sent).toHaveLength(0);
      app.change("second");
      for (let i = 0; i < 5; i++) await watches.poll();
      expect(app.reads).toHaveLength(2);
      expect(sent.map((update) => update.sessions[0]?.title)).toEqual(["second"]);
    } finally {
      watches.dropAll();
    }
  });
});
