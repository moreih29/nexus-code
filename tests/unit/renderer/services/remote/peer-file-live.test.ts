import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_BYTES_CHUNK } from "../../../../../packages/remote-protocol/src/rpc";
import { PeerFileReads } from "../../../../../src/main/features/remote/peer-file-reads";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const live = await import("../../../../../src/renderer/services/remote/peer-file-live");
const { peerWorkspaceId } = await import(
  "../../../../../src/renderer/services/remote/peer-workspace"
);
const { FileLookBody, useFileLookView } = await import(
  "../../../../../src/renderer/components/chat/file-look"
);
const { ChatFilesContext } = await import("../../../../../src/renderer/services/chat/chat-files");
const { peerChatFiles } = await import(
  "../../../../../src/renderer/services/remote/peer-chat-media"
);

const WS = peerWorkspaceId("d1", "w1");
const globals = globalThis as Record<string, unknown>;

let content = "";
let version: string | undefined;
let missing = false;
let requests: { path: string; length?: number; ifVersion?: string; versioned?: true }[] = [];
let gate: Promise<void> | null = null;
let saved: unknown;
let savedInterval: unknown;
let savedClearInterval: unknown;
let savedDocument: unknown;
let visible = "visible";
const handlers: Record<string, () => void> = {};
let tick: (() => void) | null = null;
let cleared = 0;
const stops: (() => void)[] = [];

const watch = (path: string, mode?: "text" | "version" | "image", connection?: number) => {
  let notified = 0;
  const stop = live.watchPeerFile(WS, path, () => notified++, mode, connection);
  stops.push(stop);
  return { stop, count: () => notified };
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};
const text = (path = "/w/a.md") => live.peerFileSnapshot(WS, path)?.text;

beforeEach(() => {
  content = "one";
  version = "v1";
  missing = false;
  requests = [];
  gate = null;
  cleared = 0;
  const cache = new PeerFileReads(async (_device, args) => {
    requests.push({
      path: args.path,
      length: args.length,
      ifVersion: args.ifVersion,
      versioned: args.versioned,
    });
    await gate;
    if (missing) throw new Error("gone");
    if (version && args.ifVersion === version) return { kind: "notModified", version };
    const bytes = Buffer.from(content);
    const offset = args.offset ?? 0;
    const length = args.length ?? MAX_BYTES_CHUNK;
    return {
      kind: "bytes",
      path: args.path,
      data: bytes.subarray(offset, offset + length).toString("base64"),
      offset,
      size: bytes.length,
      ...(version && (args.versioned || args.ifVersion || args.requireVersion) ? { version } : {}),
    };
  });
  cache.updateRoom({
    status: "online",
    peers: [{ id: "d1", name: "peer", platform: "linux", online: true, schema: "0.13.4" }],
  });
  saved = globals.window;
  savedDocument = globals.document;
  visible = "visible";
  globals.document = {
    get visibilityState() {
      return visible;
    },
    addEventListener: (name: string, fn: () => void) => {
      handlers[name] = fn;
    },
    removeEventListener: (name: string) => {
      delete handlers[name];
    },
  };
  globals.window = {
    addEventListener: (name: string, fn: () => void) => {
      handlers[name] = fn;
    },
    removeEventListener: (name: string) => {
      delete handlers[name];
    },
    ipc: {
      call: async (_c: string, _m: string, a: Record<string, unknown>) => {
        try {
          return ipcOk(
            await cache.readBytes(
              a as { deviceId: string; workspaceId: string },
              a.path as string,
              a.offset as number,
              a.length as number,
              !!a.whole,
              a.requireVersion as string | undefined,
            ),
          );
        } catch {
          return ipcErr("unavailable", "gone");
        }
      },
      cancel: () => {},
    },
  };
  savedInterval = globals.setInterval;
  savedClearInterval = globals.clearInterval;
  tick = null;
  globals.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  globals.clearInterval = () => {
    cleared++;
    tick = null;
  };
});

afterEach(() => {
  try {
    for (const stop of stops.splice(0)) stop();
  } finally {
    globals.window = saved;
    globals.document = savedDocument;
    globals.setInterval = savedInterval;
    globals.clearInterval = savedClearInterval;
  }
});

describe("a file of another computer's, kept current", () => {
  test("a preview image URL follows the file version across polls and chat access epochs", async () => {
    const path = "/w/image.png";
    const url = "nexus-workspace://peer/d1/w1/w/image.png";
    function PreviewImage() {
      const view = useFileLookView(path, {});
      return createElement(FileLookBody, { workspaceId: WS, root: "/w", path, view });
    }
    function render(epoch?: number) {
      const image = createElement(PreviewImage);
      if (epoch === undefined) return renderToStaticMarkup(image);
      const files = peerChatFiles(
        { deviceId: "d1", workspaceId: "w1" },
        {
          scopeId: 1,
          read: { id: epoch, cacheId: 1, scopeId: 1, signal: new AbortController().signal },
        },
      );
      return renderToStaticMarkup(
        createElement(ChatFilesContext.Provider, { value: files }, image),
      );
    }

    const plain = watch(path, "image");
    const chat = watch(path, "image", 1);
    await settle();
    expect(render()).toContain(`src="${url}?v=v1"`);
    expect(render(3)).toContain(`src="${url}?v=v1"`);
    expect(render(4)).toContain(`src="${url}?v=v1"`);

    tick?.();
    await settle();
    expect(chat.count()).toBe(1);

    version = "v2";
    tick?.();
    await settle();
    expect(render(4)).toContain(`src="${url}?v=v2"`);
    expect(render()).toContain(`src="${url}?v=v2"`);

    chat.stop();
    plain.stop();
    expect(render(5)).toContain(`src="${url}?v=v2"`);
    expect(render()).toContain(`src="${url}?v=v2"`);
    watch(path, "image", 1);
    await settle();
    expect(render(5)).toContain(`src="${url}?v=v2"`);
  });

  test("reads once with a version, and a re-read that finds it unchanged keeps what is shown", async () => {
    const view = watch("/w/a.md");
    await settle();
    expect(text()).toEqual({ kind: "text", text: "one" });
    expect(requests[0]?.versioned).toBe(true);
    const shown = live.peerFileSnapshot(WS, "/w/a.md");
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    await settle();
    expect(requests.some((r) => r.ifVersion === "v1")).toBe(true);
    expect(live.peerFileSnapshot(WS, "/w/a.md")).toBe(shown);
    expect(view.count()).toBe(1);
  });

  test("a changed file replaces what is shown, with the old one shown until then", async () => {
    const view = watch("/w/a.md");
    await settle();
    content = "two";
    version = "v2";
    gate = new Promise((resolve) => setTimeout(resolve, 20));
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    expect(text()).toEqual({ kind: "text", text: "one" });
    await settle();
    await gate;
    await settle();
    expect(text()).toEqual({ kind: "text", text: "two" });
    expect(view.count()).toBe(2);
  });

  test("a file that is gone shows as failed", async () => {
    watch("/w/a.md");
    await settle();
    missing = true;
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    await settle();
    expect(text()).toEqual({ kind: "failed" });
  });

  test("a change to another file leaves this one alone", async () => {
    watch("/w/a.md");
    await settle();
    const before = requests.length;
    live.refreshPeerFiles(WS, ["/w/b.md"]);
    await settle();
    expect(requests.length).toBe(before);
  });

  test("a relative name of the changed file matches its absolute path", async () => {
    watch("/w/src/a.md");
    await settle();
    const before = requests.length;
    live.refreshPeerFiles(WS, ["src/a.md"]);
    await settle();
    expect(requests.length).toBeGreaterThan(before);
  });

  test("the periodic check asks the version only, and reads when it moved", async () => {
    watch("/w/a.md");
    await settle();
    requests = [];
    tick?.();
    await settle();
    expect(requests.every((r) => r.length === 1 && r.ifVersion === "v1")).toBe(true);
    expect(text()).toEqual({ kind: "text", text: "one" });
    content = "three";
    version = "v3";
    tick?.();
    await settle();
    expect(text()).toEqual({ kind: "text", text: "three" });
  });

  test("a host without versions is read again only when told, comparing the content", async () => {
    version = undefined;
    const view = watch("/w/a.md");
    await settle();
    requests = [];
    tick?.();
    await settle();
    expect(requests).toEqual([]);
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    await settle();
    expect(requests.length).toBeGreaterThan(0);
    expect(view.count()).toBe(1);
    content = "changed";
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    await settle();
    expect(text()).toEqual({ kind: "text", text: "changed" });
  });

  test("a window looked at again reads the files, a hidden one does not poll", async () => {
    watch("/w/a.md");
    await settle();
    content = "back";
    version = "v2";
    visible = "hidden";
    tick?.();
    handlers.focus?.();
    await settle();
    expect(text()).toEqual({ kind: "text", text: "one" });
    visible = "visible";
    handlers.focus?.();
    await settle();
    expect(text()).toEqual({ kind: "text", text: "back" });
    expect(handlers.visibilitychange).toBeDefined();
  });

  test("views of one file share one read", async () => {
    gate = new Promise((resolve) => setTimeout(resolve, 10));
    const a = watch("/w/a.md");
    const b = watch("/w/a.md");
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    live.refreshPeerFiles(WS, ["/w/a.md"]);
    await gate;
    await settle();
    expect(requests.filter((r) => r.versioned).length).toBe(1);
    expect(live.watchedPeerFileCount()).toBe(1);
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(1);
  });

  test("the periodic check stops with the last view", async () => {
    const a = watch("/w/a.md");
    const b = watch("/w/a.md");
    await settle();
    expect(live.peerFilePollRunning()).toBe(true);
    a.stop();
    expect(live.peerFilePollRunning()).toBe(true);
    b.stop();
    expect(live.peerFilePollRunning()).toBe(false);
    expect(live.watchedPeerFileCount()).toBe(0);
    expect(cleared).toBe(1);
    expect(handlers.focus).toBeUndefined();
  });

  test("a revision view counts the file's changes by its version, without its content", async () => {
    const view = watch("/w/i.png", "version");
    await settle();
    expect(live.peerFileSnapshot(WS, "/w/i.png", "version")?.revision).toBe(0);
    expect(requests.every((r) => r.length === 1)).toBe(true);
    live.refreshPeerFiles(WS, ["/w/i.png"]);
    await settle();
    expect(live.peerFileSnapshot(WS, "/w/i.png", "version")?.revision).toBe(0);
    version = "v2";
    live.refreshPeerFiles(WS, ["/w/i.png"]);
    await settle();
    expect(live.peerFileSnapshot(WS, "/w/i.png", "version")?.revision).toBe(1);
    expect(view.count()).toBe(2);
  });
});
