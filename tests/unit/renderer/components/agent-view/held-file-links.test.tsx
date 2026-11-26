import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { heldFileLinks } from "../../../../../src/renderer/components/agent-view/held-file-links";
import { watchToasts } from "../../../../../src/renderer/components/ui/toast";
import {
  type ChatFiles,
  type LinkedFile,
  LinkGrantError,
} from "../../../../../src/renderer/services/chat/chat-files";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";

const file = { deviceId: "d1", workspaceId: "w1", path: "/outside/qa/notes.md" };
const held = { deviceName: "qa-desk", workspaceRoot: "/repo", tabId: "t1" };
const parent = { kind: "file", parent: "/outside/qa/notes.md" } as const;

function chatFiles(over: Partial<ChatFiles> = {}): ChatFiles & { opened: LinkedFile[] } {
  const opened: LinkedFile[] = [];
  const files = {
    access: null,
    epoch: 1,
    connection: 1,
    there: async (paths: readonly string[]) => new Set(paths),
    picture: async () => ({ mediaType: "image/png", data: "AAA" }),
    subscribePicture: () => () => {},
    ...over,
  } as ChatFiles;
  if (over.open) {
    const open = over.open;
    files.open = (link, purpose) => {
      opened.push(link);
      return open(link, purpose);
    };
  }
  return Object.assign(files, { opened });
}

let placed: { key: string; from: string; details: Record<string, unknown> }[] = [];
let toasts: string[] = [];
const stops: (() => void)[] = [];

beforeEach(() => {
  placed = [];
  toasts = [];
  const place = spyOn(useAgentViewStore.getState(), "placeRemoteFile").mockImplementation(
    (key, from, details) => {
      placed.push({ key, from, details });
    },
  );
  stops.push(
    () => place.mockRestore(),
    watchToasts((toast) => toasts.push(String(toast.message))),
  );
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a link inside a held file opens beside it with the chat tab it came from", () => {
  const links = heldFileLinks(file, held, chatFiles());
  links.openFile("/repo/src/a.ts");
  expect(placed).toEqual([
    {
      key: expect.stringContaining(encodeURIComponent("/repo/src/a.ts")),
      from: expect.stringContaining(encodeURIComponent(file.path)),
      details: { deviceName: "qa-desk", workspaceRoot: "/repo", at: undefined, tabId: "t1" },
    },
  ]);
});

test("a link out of the workspace asks for a grant with the file as its source", async () => {
  const files = chatFiles({ open: async () => "/outside/qa/other.md" });
  const links = heldFileLinks(file, held, files);
  const link = { href: "other.md:7", source: parent };
  links.openFile("other.md:7", { link });
  await settle();
  expect(files.opened).toEqual([link]);
  expect(placed).toHaveLength(1);
  expect(placed[0]?.key).toContain(encodeURIComponent("/outside/qa/other.md"));
  expect(placed[0]?.details.at).toEqual({ line: 7 });
});

test("an absolute link inside the workspace opens with no grant", () => {
  const files = chatFiles({ open: async () => "/never" });
  heldFileLinks(file, held, files).openFile("/repo/a.md", {
    link: { href: "/repo/a.md", source: parent },
  });
  expect(files.opened).toEqual([]);
  expect(placed[0]?.key).toContain(encodeURIComponent("/repo/a.md"));
});

test("a refused grant opens nothing and says why", async () => {
  const files = chatFiles({
    open: async () => {
      throw new LinkGrantError("gone", "not-found");
    },
  });
  heldFileLinks(file, held, files).openFile("x.md", { link: { href: "x.md", source: parent } });
  await settle();
  expect(placed).toEqual([]);
  expect(toasts).toHaveLength(1);
});

test("an older host keeps the path as the file names it", () => {
  heldFileLinks(file, { ...held, tabId: undefined }, chatFiles()).openFile("/repo/b.md", {
    link: { href: "/repo/b.md", source: parent },
  });
  expect(placed[0]?.details).toEqual({
    deviceName: "qa-desk",
    workspaceRoot: "/repo",
    at: undefined,
  });
});
