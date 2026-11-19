import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ImageBlock } from "../../../../../src/renderer/services/chat/model";
import type { RoomState } from "../../../../../src/shared/remote/room";

const { beforeOfHunks } = await import(
  "../../../../../src/renderer/components/agent-view/remote-links"
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

describe("another computer's chat, read from there", () => {
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
        ? { mediaType: "image/jpeg", data: "", version: "v1", notModified: true }
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

  test("expired and mismatched attachment proofs never authorize cached data", async () => {
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
      await load(attachment());
      expect(calls.at(-1)?.args.ifVersion).toBeUndefined();
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
    expect(peerChatAccess("d1")?.id).not.toBe(current.epoch!);
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

  test("foreground keeps attachment candidates but rejoin clears their versions", async () => {
    answer = (_method, args) =>
      args.ifVersion === "v1"
        ? { mediaType: "image/jpeg", data: "", version: "v1", notModified: true }
        : { mediaType: "image/jpeg", data: "AAA", version: "v1" };
    const load = () => peerImageLoader(target, peerChatAccess("d1"))(attachment());
    await load();
    desktop.dispatchEvent(new Event("focus"));
    await load();
    events.get("roomChanged")?.(online(1));
    await load();
    expect(calls.map(({ args }) => args.ifVersion)).toEqual([undefined, "v1", undefined]);
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
