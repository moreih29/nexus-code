import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import { setImmediate as flush } from "node:timers/promises";
import type { WebContents } from "electron";
import type { SessionsUpdate } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { RendererBridge } from "../../../../../src/main/features/cli/renderer-bridge";
import { SessionsRevisions } from "../../../../../src/main/features/cli/sessions-revisions";
import {
  SESSIONS_REREAD_MS,
  snapshotSessions,
} from "../../../../../src/main/features/remote/serving/sessions";
import {
  SESSIONS_POLL_MS,
  SessionWatches,
} from "../../../../../src/main/features/remote/session-watches";
import { chatKey, unseenSends } from "../../../../../src/renderer/services/chat/store";
import { sendUnseen } from "../../../../../src/renderer/services/chat/transport/submission";
import { chatInfoOf } from "../../../../../src/renderer/services/cli/chat-view";
import type { CliChatState } from "../../../../../src/shared/cli/ui";
import { testSessionsRevision } from "../../../../helpers/sessions-snapshot";

function renderer(state: () => CliChatState = () => "idle") {
  let revision = 100;
  let title = "first";
  let chatReadable = true;
  let unreadReadable = true;
  let workspaceIds = ["w1"];
  const reads: string[][] = [];
  const services = {
    listWorkspaces: () => workspaceIds.map((id) => ({ id, name: id, rootPath: `/${id}` })),
    claudeStatus: () => null,
    activity: () => null,
    claudeAsks: () => [],
    claudeAgents: { list: () => [] },
    consents: { list: () => [], listResolutions: () => [] },
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
              ...(chatReadable ? { chat: { state: state(), since: 1 } } : {}),
            },
          ],
        })),
        ...(unreadReadable ? { unread: {} } : {}),
      };
    },
  } as unknown as CliServices;
  const revisions = testSessionsRevision((args, timeoutMs) =>
    services.ui("sessions.snapshot", args, timeoutMs),
  );
  const withRevisions = { ...services, sessionsRevision: revisions };
  return {
    services: withRevisions,
    reads,
    change(next: string) {
      title = next;
      revision++;
      revisions.saw(revision);
    },
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

  test("the windows track separate revisions, replies and cache lifetimes", async () => {
    const bridge = new RendererBridge(() => null);
    function window(id: number, revision: number, title: string) {
      const events = new EventEmitter();
      let destroyed = false;
      const requests: string[] = [];
      const contents = Object.assign(events, {
        id,
        isDestroyed: () => destroyed,
        send: (_channel: string, _group: string, _event: string, body: { requestId: string }) =>
          requests.push(body.requestId),
      }) as unknown as WebContents;
      return {
        contents,
        requests,
        answer(requestId: string, senderId = id, currentTitle = title) {
          bridge.resolve(
            {
              requestId,
              ok: true,
              value: {
                revision,
                unread: {},
                workspaces: [
                  {
                    tabs: [
                      { id: "t1", type: "claude", title: currentTitle, chat: { state: "idle" } },
                    ],
                  },
                ],
              },
            },
            senderId,
          );
        },
        close() {
          destroyed = true;
          events.emit("destroyed");
        },
      };
    }
    const first = window(10, 100, "first");
    const second = window(20, 60_000, "second");
    let active = first;
    const revisions = new SessionsRevisions(bridge, () => active.contents);
    const services = { ...renderer().services, sessionsRevision: revisions };
    try {
      revisions.saw(first.contents, 100);
      revisions.saw(second.contents, 60_000);
      const initial = titles(services);
      active = second;
      first.answer(first.requests[0]!, second.contents.id, "wrong reply");
      first.answer(first.requests[0]!);
      expect(await initial).toEqual(["first"]);

      const other = titles(services);
      second.answer(second.requests[0]!);
      expect(await other).toEqual(["second"]);
      active = first;
      revisions.saw(second.contents, 60_001);
      for (let i = 0; i < 5; i++) expect(await titles(services)).toEqual(["first"]);
      expect(first.requests).toHaveLength(1);
      expect(second.requests).toHaveLength(1);

      const closed = revisions.current();
      revisions.saw(first.contents, 101);
      const closing = titles(services);
      expect(first.requests).toHaveLength(2);
      first.close();
      expect(await closing).toEqual([]);
      expect(closed?.latest).toBeUndefined();
      expect(revisions.current()).toBeUndefined();
      const replacement = window(first.contents.id, 1, "replacement");
      active = replacement;
      const reopened = titles(services);
      replacement.answer(replacement.requests[0]!);
      expect(await reopened).toEqual(["replacement"]);
      expect(replacement.requests).toHaveLength(1);
    } finally {
      revisions.dispose();
      bridge.dispose();
    }
  });
});

describe("a watched sessions' list", () => {
  test("an unseen send clearing reaches a watch within ten seconds without a revision change", async () => {
    const key = chatKey("w1", "t1");
    unseenSends.set(key, { before: 0 });
    const app = renderer(() => chatInfoOf("claude", undefined, sendUnseen("w1", "t1")).state);
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
    });
    try {
      const first = await watches.watch("phone");
      expect(first.sessions[0]?.state).toBe("running");
      jest.advanceTimersByTime(1);
      app.change("cached");
      await titles(app.services);
      unseenSends.delete(key);
      for (let elapsed = 0; elapsed < 10_000; elapsed += SESSIONS_POLL_MS) {
        jest.advanceTimersByTime(SESSIONS_POLL_MS);
        await flush();
        if (sent.at(-1)?.sessions[0]?.state === "idle") break;
      }
      expect(sent.at(-1)?.sessions[0]?.state).toBe("idle");
      expect(app.reads).toHaveLength(3);
    } finally {
      unseenSends.delete(key);
      watches.dropAll();
    }
  });

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
