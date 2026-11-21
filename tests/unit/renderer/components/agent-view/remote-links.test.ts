import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as React from "react";
import {
  ImageLoaderContext,
  useImageBytes,
} from "../../../../../src/renderer/components/chat/chat-image";
import {
  ChatFilesContext,
  useChatFiles,
  useFilePicture,
} from "../../../../../src/renderer/services/chat/chat-files";
import { useFoundFiles } from "../../../../../src/renderer/services/chat/file-presence";
import type { ImageBlock } from "../../../../../src/renderer/services/chat/model";
import type { RoomState } from "../../../../../src/shared/remote/room";

const { beforeOfHunks } = await import(
  "../../../../../src/renderer/services/remote/file-comparison"
);
const { peerChatAccess, peerChatFiles, peerImageLoader, watchPeerChatAccess } = await import(
  "../../../../../src/renderer/services/remote/peer-chat-media"
);
const { shownPath } = await import("../../../../../src/renderer/utils/path");
const { rateLimitOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-usage"
);
const { senderOf } = await import("../../../../../src/renderer/services/remote/chat-model");
const { folderOf } = await import("../../../../../src/renderer/components/chat/answer-extras");

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
let answer: (method: string, args: Record<string, unknown>) => unknown = () => ({});
const globals = globalThis as Record<string, unknown>;
const desktop = new EventTarget();
const documentEvents = new EventTarget();
const events = new Map<string, (args: unknown) => void>();
const watched: (() => void)[] = [];
const target = { deviceId: "d1", workspaceId: "w1", tabId: "t1" };
const picturePath = "/w/a.png";
const pictureResult = (data: string) => ({
  kind: "image",
  path: picturePath,
  size: data.length,
  mediaType: "image/png",
  data,
});

const attachment = (itemKey = "u-1"): ImageBlock => ({
  mediaType: "image/jpeg",
  data: "",
  remote: { kind: "user", itemKey, index: 0 },
});

const online = (rejoins = 0): RoomState => ({
  status: "online",
  peers: ["d1", "d2"].map((id) => ({ id, online: true, name: id, platform: "darwin", rejoins })),
});

function offline(): RoomState {
  const room = online();
  return {
    ...room,
    peers: room.peers.map((peer) =>
      peer.id === target.deviceId ? { ...peer, online: false } : peer,
    ),
  };
}

const signedIn = (id = "user") => ({
  status: "signed-in",
  server: "https://relay.example",
  user: { id },
  device: { id: "self" },
});

let savedWindow: unknown;
let savedDocument: unknown;

beforeEach(() => {
  calls.length = 0;
  savedWindow = globals.window;
  savedDocument = globals.document;
  globals.window = Object.assign(desktop, {
    ipc: {
      call: async (_channel: string, method: string, args: Record<string, unknown>) => {
        if (method === "room") return online();
        if (method === "account") return signedIn();
        calls.push({ method, args });
        return answer(method, args);
      },
      listen: (_channel: string, event: string, callback: (args: unknown) => void) => {
        events.set(event, callback);
        return () => events.delete(event);
      },
      cancel: () => {},
    },
  });
  globals.document = Object.assign(documentEvents, { visibilityState: "visible" });
  watched.push(
    watchPeerChatAccess("d1", () => {}),
    watchPeerChatAccess("d2", () => {}),
  );
  events.get("roomChanged")?.(online());
});

afterEach(() => {
  for (const off of watched.splice(0)) off();
  globals.window = savedWindow;
  globals.document = savedDocument;
});

const panel = {
  todos: [],
  tasks: [],
  agents: [],
  changedFiles: [],
  context: null,
  goal: null,
};

interface MediaDispatcher {
  useCallback(callback: unknown): unknown;
  useContext(): unknown;
  useDebugValue(): void;
  useEffect(effect: React.EffectCallback, deps: React.DependencyList): void;
  useState(initial: unknown): [unknown, (next: unknown) => void];
  useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown;
}

/** Drives one hook's state and effects with a supplied context value. */
function mountMedia<C, T>(_context: React.Context<C>, hook: () => T) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: MediaDispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let value: C;
  let state: unknown;
  let initialized = false;
  let deps: React.DependencyList | undefined;
  let cleanup: ReturnType<React.EffectCallback>;
  let commit: (() => void) | undefined;
  const dispatcher: MediaDispatcher = {
    useCallback: (callback) => callback,
    useContext: () => value,
    useDebugValue: () => {},
    useEffect(effect, next) {
      if (
        deps?.length === next.length &&
        next.every((item, index) => Object.is(item, deps?.[index]))
      )
        return;
      commit = () => {
        cleanup?.();
        deps = next;
        cleanup = effect();
      };
    },
    useState(initial) {
      if (!initialized) {
        state = typeof initial === "function" ? initial() : initial;
        initialized = true;
      }
      return [
        state,
        (next) => {
          state = typeof next === "function" ? next(state) : next;
        },
      ];
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const unmount = () => cleanup?.();
  watched.push(unmount);
  return (contextValue: C) => {
    value = contextValue;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      return hook();
    } finally {
      internals.H = previous;
      const finish = commit;
      commit = undefined;
      finish?.();
    }
  };
}

describe("another computer's chat, read from there", () => {
  test.each([
    { change: "focus", keep: true, outcome: "notModified" },
    { change: "rejoin", keep: true, outcome: "new bytes" },
    { change: "rejoin", keep: true, outcome: "failure" },
    { change: "offline rejoin", keep: true, outcome: "notModified" },
    { change: "sign-out", keep: false, outcome: "no access" },
    { change: "account switch", keep: false, outcome: "new bytes" },
    { change: "room closes", keep: false, outcome: "no access" },
    { change: "peer removed", keep: false, outcome: "new bytes" },
    { change: "read permission removed", keep: false, outcome: "failure" },
    { change: "file permission removed while offline", keep: false, outcome: "paused" },
    { change: "different ref", keep: false, outcome: "new bytes" },
    { change: "different tab", keep: false, outcome: "new bytes" },
  ])("the displayed attachment after $change and $outcome", async ({ change, keep, outcome }) => {
    let ref = attachment();
    const render = mountMedia(ImageLoaderContext, () => useImageBytes(ref));
    const first = peerImageLoader(target, peerChatAccess("d1"));
    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    expect(render(first).image).toBeNull();
    await Bun.sleep(0);
    const original = render(first).image;
    expect(original?.data).toBe("AAA");

    if (change === "focus") desktop.dispatchEvent(new Event("focus"));
    if (change === "rejoin") events.get("roomChanged")?.(online(1));
    if (
      change === "offline rejoin" ||
      change === "peer removed" ||
      change === "room closes" ||
      change === "file permission removed while offline"
    ) {
      events.get("roomChanged")?.(offline());
      const paused = peerImageLoader(target, peerChatAccess("d1"));
      expect(render(paused)).toEqual({ image: original, failed: false });
      desktop.dispatchEvent(new Event("focus"));
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      if (change === "offline rejoin") events.get("roomChanged")?.(online(1));
      if (change === "peer removed") {
        events.get("roomChanged")?.({ status: "online", peers: [] });
        expect(peerChatAccess("d1")).toBeNull();
        events.get("roomChanged")?.(online(1));
      }
      if (change === "file permission removed while offline") {
        const room = offline();
        events.get("roomChanged")?.({
          ...room,
          peers: room.peers.map((peer) => ({ ...peer, serves: ["chat.read"] })),
        });
      }
    }
    if (change === "sign-out") events.get("accountChanged")?.({ status: "signed-out" });
    if (change === "account switch") {
      events.get("accountChanged")?.(signedIn("another-user"));
      expect(peerChatAccess("d1")).toBeNull();
      // React may receive the new room before it renders the null access.
      events.get("roomChanged")?.(online());
    }
    if (change === "room closes") events.get("roomChanged")?.({ ...offline(), status: "waiting" });
    if (change === "read permission removed") {
      const room = online(1);
      events.get("roomChanged")?.({
        ...room,
        peers: room.peers.map((peer) => ({ ...peer, serves: ["files"] })),
      });
    }
    if (change === "different ref") ref = attachment("u-2");
    const site = change === "different tab" ? { ...target, tabId: "t2" } : target;
    const load = change === "different ref" ? first : peerImageLoader(site, peerChatAccess("d1"));
    const reply = Promise.withResolvers<unknown>();
    answer = () => reply.promise;
    const paused = outcome === "no access" || outcome === "paused";
    expect(render(load)).toMatchObject({
      image: keep ? original : null,
      failed: paused,
    });
    await Bun.sleep(0);
    if (paused) {
      expect(calls).toHaveLength(1);
      return;
    }
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.args.ifVersion).toBe(keep ? "v1" : undefined);

    if (outcome === "failure") reply.reject(new Error("attachment removed"));
    else if (outcome === "notModified") {
      reply.resolve({ mediaType: "image/jpeg", data: "", version: "v1", notModified: true });
    } else reply.resolve({ mediaType: "image/jpeg", data: "BBB", version: "v2" });
    await Bun.sleep(0);
    const shown = render(load);
    expect(shown.failed).toBe(outcome === "failure");
    if (outcome === "notModified") expect(shown.image).toBe(original);
    else if (outcome === "failure") expect(shown.image).toBeNull();
    else expect(shown.image?.data).toBe("BBB");
  });

  test("an aborted attachment recheck leaves the displayed bytes in place", async () => {
    const image = attachment();
    const render = mountMedia(ImageLoaderContext, () => useImageBytes(image));
    const current = () => peerImageLoader(target, peerChatAccess("d1"));
    const first = current();
    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    render(first);
    await Bun.sleep(0);
    const original = render(first).image;
    expect(original?.data).toBe("AAA");

    desktop.dispatchEvent(new Event("focus"));
    const reply = Promise.withResolvers<unknown>();
    answer = () => reply.promise;
    expect(render(current()).image).toBe(original);
    await Bun.sleep(0);

    desktop.dispatchEvent(new Event("focus"));
    reply.reject(new Error("previous access ended"));
    await Bun.sleep(0);
    answer = () => ({ mediaType: "image/jpeg", data: "", version: "v1", notModified: true });
    const latest = current();
    expect(render(latest).image).toBe(original);
    await Bun.sleep(0);
    expect(render(latest).image).toBe(original);
  });

  test.each([
    "window focus",
    "panel switch",
    "peer reconnect",
  ])("file cards and links stay while rechecked after %s", async (trigger) => {
    const renderPicture = mountMedia(ChatFilesContext, () =>
      useFilePicture(useChatFiles(), picturePath),
    );
    const renderLinks = mountMedia(ChatFilesContext, () =>
      useFoundFiles("peer-workspace", "/w", [picturePath]),
    );
    const files = (visible = true) => peerChatFiles(target, peerChatAccess("d1"), visible);
    const first = files();
    answer = (method) =>
      method === "peerFilesList"
        ? { entries: [{ name: "a.png", kind: "file" }] }
        : pictureResult("AAA");
    renderPicture(first);
    renderLinks(first);
    await Bun.sleep(0);
    expect(renderPicture(first).image?.data).toBe("AAA");
    expect(renderLinks(first).has(picturePath)).toBe(true);

    if (trigger === "panel switch") {
      const hidden = files(false);
      expect(renderPicture(hidden).image?.data).toBe("AAA");
      expect(renderLinks(hidden).has(picturePath)).toBe(true);
      await Bun.sleep(0);
      expect(calls).toHaveLength(2);
    } else if (trigger === "peer reconnect") {
      events.get("roomChanged")?.(offline());
      const paused = files();
      expect(renderPicture(paused).image?.data).toBe("AAA");
      expect(renderLinks(paused).has(picturePath)).toBe(true);
      await Bun.sleep(0);
      expect(calls).toHaveLength(2);
      events.get("roomChanged")?.(online(1));
    } else desktop.dispatchEvent(new Event("focus"));

    const front = files();
    const reply = Promise.withResolvers<unknown>();
    answer = () => reply.promise;
    expect(renderPicture(front).image?.data).toBe("AAA");
    expect(renderLinks(front).has(picturePath)).toBe(true);
    await Bun.sleep(0);
    expect(calls).toHaveLength(trigger === "panel switch" ? 3 : 4);
    reply.reject(new Error("file removed"));
    await Bun.sleep(0);
    expect(renderPicture(front)).toMatchObject({ image: null, failed: true });
    expect(renderLinks(front).has(picturePath)).toBe(trigger === "panel switch");
  });

  test("a file the conversation names is there when its folder lists it", async () => {
    answer = (method, args) =>
      method === "peerFilesList" && args.path === "/w/src"
        ? {
            path: "/w/src",
            entries: [
              { name: "a.ts", kind: "file" },
              { name: "lib", kind: "dir" },
            ],
          }
        : Promise.reject(new Error("outside the workspace"));
    const files = peerChatFiles(target, peerChatAccess("d1"));
    const found = await files.there(["/w/src/a.ts", "/w/src/lib", "/w/src/gone.ts", "/etc/x"]);
    expect([...found]).toEqual(["/w/src/a.ts"]);
    // Each folder is listed once while its entries are fresh.
    await files.there(["/w/src/a.ts"]);
    expect(calls.filter((c) => c.args.path === "/w/src")).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ deviceId: "d1", workspaceId: "w1", path: "/w/src" });
  });

  test("a Windows path is split at its backslashes", async () => {
    answer = () => ({ path: "C:\\w", entries: [{ name: "a.png", kind: "file" }] });
    const files = peerChatFiles(target, peerChatAccess("d1"));
    expect([...(await files.there(["C:\\w\\a.png"]))]).toEqual(["C:\\w\\a.png"]);
    expect(calls[0]?.args.path).toBe("C:\\w");
  });

  test("mutable pictures share requests only while pending and overwrite mounted consumers", async () => {
    const read = Promise.withResolvers<unknown>();
    answer = () => read.promise;
    const files = peerChatFiles(target, peerChatAccess("d1"));
    const anotherView = peerChatFiles(target, peerChatAccess("d1"));
    const seen: (ImageBlock | null)[] = [];
    const off = files.subscribePicture(picturePath, (image) => seen.push(image));
    const first = files.picture(picturePath);
    const sameRead = anotherView.picture(picturePath);
    read.resolve(pictureResult("AAA"));
    expect(await first).toEqual({ mediaType: "image/png", data: "AAA" });
    expect(await sameRead).toBe(await first);
    expect(calls).toHaveLength(1);

    answer = () => pictureResult("BBB");
    await anotherView.picture(picturePath);
    answer = () => Promise.reject(new Error("access denied"));
    await expect(anotherView.picture(picturePath)).rejects.toThrow("access denied");
    expect(seen.map((image) => image?.data)).toEqual(["AAA", "BBB", undefined]);
    expect(calls.map(({ method }) => method)).toEqual(Array(3).fill("peerFilesRead"));
    off();
  });

  test("distinct workspaces and devices do not share mutable paths or folder entries", async () => {
    answer = (method, args) =>
      method === "peerFilesList"
        ? { entries: [{ name: `${args.deviceId}-${args.workspaceId}.png`, kind: "file" }] }
        : pictureResult(`${args.deviceId}-${args.workspaceId}`);
    const sites = [target, { ...target, workspaceId: "w2" }, { ...target, deviceId: "d2" }];
    const files = sites.map((site) =>
      peerChatFiles(
        { deviceId: site.deviceId, workspaceId: site.workspaceId },
        peerChatAccess(site.deviceId),
      ),
    );
    const photos = await Promise.all(files.map((f) => f.picture(picturePath)));
    expect(photos.map((image) => image.data)).toEqual(["d1-w1", "d1-w2", "d2-w1"]);
    const paths = sites.map((site) => `/w/${site.deviceId}-${site.workspaceId}.png`);
    expect(await Promise.all(files.map((f) => f.there(paths)))).toEqual(
      paths.map((path) => new Set([path])),
    );
  });

  test("an immutable ref shares its first fetch and then requires its own version proof", async () => {
    answer = (_method, args) =>
      args.ifVersion === "v1"
        ? { mediaType: "image/png", data: "", version: "v1", notModified: true }
        : { mediaType: "image/jpeg", data: "BBB", version: "v1" };
    const load = peerImageLoader(target, peerChatAccess("d1"));
    const image = attachment();
    const [first, duplicate] = await Promise.all([load(image), load(image)]);
    expect(first).toEqual({ mediaType: "image/jpeg", data: "BBB" });
    expect(duplicate).toBe(first);
    expect(await load(image)).toBe(first);
    expect(calls).toEqual([
      {
        method: "peerChatImage",
        args: { ...target, maxEdge: 2048, ref: image.remote, versioned: true },
      },
      {
        method: "peerChatImage",
        args: { ...target, maxEdge: 2048, ref: image.remote, ifVersion: "v1" },
      },
    ]);
    const here = { mediaType: "image/png", data: "CCC" };
    expect(await load(here)).toBe(here);
  });

  test("an attachment denial clears mounted observers and drops the old version", async () => {
    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    const load = peerImageLoader(target, peerChatAccess("d1"));
    const image = attachment();
    const seen: (ImageBlock | null)[] = [];
    const off = load.subscribe(image.remote!, (next) => seen.push(next));
    await load(image);
    answer = () => Promise.reject(new Error("tab removed"));
    await expect(load(image)).rejects.toThrow("tab removed");
    expect(seen.map((value) => value?.data)).toEqual(["AAA", undefined]);
    answer = () => ({ mediaType: "image/jpeg", data: "CCC", version: "v2" });
    expect((await load(image)).data).toBe("CCC");
    expect(calls[1]?.args.ifVersion).toBe("v1");
    expect(calls[2]?.args.ifVersion).toBeUndefined();
    off();
  });

  test("only a matching version proof authorizes retained attachment bytes", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const load = peerImageLoader(target, peerChatAccess("d1"));
      answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
      await load(attachment());
      answer = () => ({ mediaType: "image/jpeg", data: "", version: "wrong", notModified: true });
      await expect(load(attachment())).rejects.toThrow("unexpected attachment validation result");
      expect(calls.at(-1)?.args.ifVersion).toBe("v1");

      answer = () => ({ mediaType: "image/jpeg", data: "BBB", version: "v2" });
      await load(attachment());
      expect(calls.at(-1)?.args.ifVersion).toBeUndefined();
      clock.mockReturnValue(31_000);
      answer = () => ({ mediaType: "image/jpeg", data: "", version: "v2", notModified: true });
      expect((await load(attachment())).data).toBe("BBB");
      expect(calls.at(-1)?.args.ifVersion).toBe("v2");
    } finally {
      clock.mockRestore();
    }
  });

  test("attachments are scoped by device, workspace, tab, ref kind and index", async () => {
    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    const first = peerImageLoader(target, peerChatAccess("d1"));
    await first(attachment());
    for (const site of [
      { ...target, workspaceId: "w2" },
      { ...target, tabId: "t2" },
      { ...target, deviceId: "d2" },
    ]) {
      await peerImageLoader(site, peerChatAccess(site.deviceId))(attachment());
    }
    await first({ ...attachment(), remote: { kind: "tool", index: 0, toolUseId: "u-1" } });
    await first({ ...attachment(), remote: { kind: "user", index: 1, itemKey: "u-1" } });
    expect(calls.map(({ args }) => args.ifVersion)).toEqual(Array(6).fill(undefined));
  });

  test("legacy hosts and held refs do not retain attachments", async () => {
    const load = peerImageLoader(target, peerChatAccess("d1"));
    answer = () => ({ mediaType: "image/jpeg", data: "AAA" });
    await load(attachment());
    await load(attachment());
    answer = () => ({ mediaType: "image/jpeg", data: "BBB", version: "unexpected" });
    const held: ImageBlock = { ...attachment(), remote: { kind: "held", index: 0, id: "h-1" } };
    await load(held);
    await load(held);
    expect(calls.map(({ args }) => args.ifVersion)).toEqual(Array(4).fill(undefined));
    expect(calls[3]?.args.versioned).toBeUndefined();
  });

  test("attachment entry quota evicts the least recently used version", async () => {
    const load = peerImageLoader(target, peerChatAccess("d1"));
    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    for (let index = 0; index < 128; index++) await load(attachment(String(index)));
    await load(attachment("0"));
    await load(attachment("128"));
    await load(attachment("0"));
    await load(attachment("1"));
    expect(calls.slice(-4).map(({ args }) => args.ifVersion)).toEqual([
      "v1",
      undefined,
      "v1",
      undefined,
    ]);
  });

  test("attachment byte quota evicts entries and declines oversized results", async () => {
    const load = peerImageLoader(target, peerChatAccess("d1"));
    const data = "A".repeat(2 * 1024 * 1024);
    answer = () => ({ mediaType: "image/jpeg", data, version: "v1" });
    for (const id of ["a", "b", "c", "d", "a"]) await load(attachment(id));
    expect(calls.at(-1)?.args.ifVersion).toBeUndefined();
    answer = () => ({ mediaType: "image/jpeg", data: "A".repeat(8 * 1024 * 1024), version: "big" });
    await load(attachment("large"));
    await load(attachment("large"));
    expect(calls.at(-1)?.args.ifVersion).toBeUndefined();
  });

  test("folder lists expire, share concurrent reads, and stay within their quota", async () => {
    const files = peerChatFiles(target, peerChatAccess("d1"));
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const entries = Array.from({ length: 1800 }, (_, index) => ({
        name: `a-${index}`.padEnd(150, "A"),
        kind: "file",
      }));
      answer = () => ({ entries });
      const name = entries[0]?.name;
      await Promise.all([files.there([`/a/${name}`]), files.there([`/a/${name}`])]);
      expect(calls).toHaveLength(1);
      clock.mockReturnValue(7000);
      await files.there([`/a/${name}`]);
      await files.there([`/b/${name}`]);
      await files.there([`/a/${name}`]);
      expect(calls.map(({ args }) => args.path)).toEqual(["/a", "/a", "/b", "/a"]);
    } finally {
      clock.mockRestore();
    }
  });

  test("foreground and peer rejoin discard old access and reject late reads", async () => {
    const old = peerChatAccess("d1");
    const stale = peerChatFiles(target, old);
    const read = Promise.withResolvers<unknown>();
    answer = () => read.promise;
    const pending = stale.picture(picturePath);
    const rejected = pending.catch((error) => error);
    await Promise.resolve();
    desktop.dispatchEvent(new Event("focus"));
    expect(peerChatAccess("d1")).not.toBe(old);
    // The foreground rechecks what a connection holds, but is still that connection.
    expect(peerChatFiles(target, peerChatAccess("d1")).epoch).not.toBe(stale.epoch);
    expect(peerChatFiles(target, peerChatAccess("d1")).connection).toBe(stale.connection);
    answer = () => pictureResult("new");
    const current = peerChatFiles(target, peerChatAccess("d1"));
    expect((await current.picture(picturePath)).data).toBe("new");
    read.resolve(pictureResult("old"));
    expect(await rejected).toBeInstanceOf(Error);
    await expect(stale.picture(picturePath)).rejects.toThrow();
    events.get("roomChanged")?.(online(1));
    expect(peerChatAccess("d1")?.read?.id).not.toBe(current.epoch!);
    expect(peerChatFiles(target, peerChatAccess("d1")).connection).not.toBe(current.connection);
    events.get("accountChanged")?.({ status: "signed-out" });
    expect(peerChatAccess("d1")).toBeNull();
    await expect(current.picture(picturePath)).rejects.toThrow();
  });

  test("in-flight pressure allows bounded waiting and frees slots on failure", async () => {
    const load = peerImageLoader(target, peerChatAccess("d1"));
    const pending = Promise.withResolvers<unknown>();
    answer = () => pending.promise;
    const active = Array.from({ length: 64 }, (_, index) => load(attachment(String(index))));
    const recorded = Promise.allSettled(active);
    const waiting = Array.from({ length: 256 }, (_, i) => load(attachment(`waiting-${i}`)));
    await expect(load(attachment("overflow"))).rejects.toThrow("too many");
    expect(calls).toHaveLength(64);

    answer = () => ({ mediaType: "image/jpeg", data: "AAA", version: "v1" });
    pending.reject(new Error("read failed"));
    expect((await recorded).every((result) => result.status === "rejected")).toBe(true);
    expect((await Promise.all(waiting)).every((image) => image.data === "AAA")).toBe(true);
    expect(calls).toHaveLength(320);
  });

  test("presence, rejoin and hello each validate the same cached attachment", async () => {
    answer = (_method, args) =>
      args.ifVersion === "v1"
        ? { mediaType: "image/jpeg", data: "", version: "v1", notModified: true }
        : { mediaType: "image/jpeg", data: "AAA", version: "v1" };
    const load = () => peerImageLoader(target, peerChatAccess("d1"))(attachment());
    const first = await load();
    events.get("roomChanged")?.(offline());
    events.get("roomChanged")?.(online());
    expect(await load()).toBe(first);
    events.get("roomChanged")?.(online(1));
    expect(await load()).toBe(first);
    const room = online(1);
    events.get("roomChanged")?.({
      ...room,
      peers: room.peers.map((peer) => ({ ...peer, schema: "0.13.4" })),
    });
    expect(await load()).toBe(first);
    expect(calls.map(({ args }) => args.ifVersion)).toEqual([undefined, "v1", "v1", "v1"]);
  });

  test("a change's file before it is the hunks against the last commit taken back", () => {
    // a b d (committed) became a c d e: b changed to c, e added at the end.
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+c", " d"] },
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1, lines: ["+e"] },
    ];
    expect(beforeOfHunks(hunks, "a\nc\nd\ne\n")).toBe("a\nb\nd\n");
    // A line taken out comes back where it was.
    expect(
      beforeOfHunks(
        [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: ["-x"] }],
        "a\nb",
      ),
    ).toBe("a\nx\nb");
    // Hunks that do not fit the file now (it changed since) give nothing.
    expect(beforeOfHunks(hunks, "z\ny\n")).toBeNull();
  });
});

describe("a Windows computer's paths, written with either separator", () => {
  test("are named from the conversation's folder", () => {
    expect(shownPath("C:/Users/me/app/README.md", "C:\\Users\\me\\app")).toBe("README.md");
    expect(shownPath("C:\\Users\\me\\app\\src\\a.ts", "C:\\Users\\me\\app\\")).toBe("src/a.ts");
    expect(shownPath("/Users/me/app/src/a.ts", "/Users/me/app")).toBe("src/a.ts");
    // Outside it, as written.
    expect(shownPath("D:\\other\\b.ts", "C:\\Users\\me\\app")).toBe("D:\\other\\b.ts");
  });

  test("a file card's folder is from there too", () => {
    expect(folderOf("C:/Users/me/app/README.md", "C:\\Users\\me\\app")).toBe("");
    expect(folderOf("C:\\Users\\me\\app\\docs\\a.md", "C:\\Users\\me\\app")).toBe("docs");
    expect(folderOf("/Users/me/app/docs/a.md", "/Users/me/app/")).toBe("docs");
  });
});

describe("what another computer's chat tells of its plan and senders", () => {
  test("a full meter is the limit reached, until its window starts over", () => {
    expect(rateLimitOf(undefined)).toBeUndefined();
    const limits = [
      { kind: "session", percent: 100, resetsAt: 5_000_000 },
      { kind: "weekly", percent: 70, resetsAt: 9_000_000 },
    ];
    expect(rateLimitOf({ ...panel, planLimits: limits }, 1_000)).toEqual({
      status: "rejected",
      rateLimitType: "session",
      resetsAt: 5_000,
    });
    expect(rateLimitOf({ ...panel, planLimits: limits }, 6_000_000)).toBeUndefined();
    expect(rateLimitOf({ ...panel, planLimits: [limits[1]!] }, 1_000)).toBeUndefined();
  });

  test("from 0.11.0, the program's own word: near the limit too, until its window starts over", () => {
    const told = {
      ...panel,
      rateLimit: { status: "allowed_warning", resetsAt: 5_000_000, kind: "five_hour" },
      planLimits: [{ kind: "session", percent: 100, resetsAt: 9_000_000 }],
    };
    expect(rateLimitOf(told, 1_000)).toEqual({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: 5_000,
    });
    expect(rateLimitOf(told, 6_000_000)).toBeUndefined();
  });

  test("a tab there that sent a message is named with its computer", () => {
    const source = { deviceId: "pc", deviceName: "Work PC", selfId: "mac" };
    expect(
      senderOf(
        { kind: "tab", name: "fix", agent: "claude", replyTo: { workspaceId: "w", tabId: "t" } },
        source,
      ),
    ).toEqual({
      kind: "tab",
      name: "fix",
      agent: "claude",
      workspaceId: "w",
      tabId: "t",
      device: { id: "pc", name: "Work PC" },
    });
  });

  test("one of this computer's tabs is this computer's, and a third computer's its own", () => {
    const source = { deviceId: "pc", deviceName: "Work PC", selfId: "mac" };
    expect(
      senderOf(
        {
          kind: "tab",
          name: "mine",
          device: { id: "mac", name: "MacBook" },
          replyTo: { deviceId: "mac", workspaceId: "w", tabId: "t" },
        },
        source,
      ),
    ).toEqual({ kind: "tab", name: "mine", workspaceId: "w", tabId: "t" });
    expect(
      senderOf(
        {
          kind: "tab",
          device: { id: "lap", name: "Laptop" },
          replyTo: { deviceId: "lap", workspaceId: "w", tabId: "t" },
        },
        source,
      ),
    ).toEqual({ kind: "tab", workspaceId: "w", tabId: "t", device: { id: "lap", name: "Laptop" } });
    // Without knowing which computer this is, a sender stays as told.
    expect(senderOf({ kind: "manager" })).toEqual({ kind: "manager" });
  });
});
