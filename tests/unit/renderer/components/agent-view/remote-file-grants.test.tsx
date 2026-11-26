import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useRemoteLinks } from "../../../../../src/renderer/components/agent-view/remote-links";
import * as fileLook from "../../../../../src/renderer/components/chat/file-look";
import {
  QuickLook,
  type QuickLookList,
} from "../../../../../src/renderer/components/chat/quick-look";
import { watchToasts } from "../../../../../src/renderer/components/ui/toast";
import {
  type ChatFiles,
  ChatFilesContext,
  type LinkedFile,
  LinkGrantError,
} from "../../../../../src/renderer/services/chat/chat-files";
import type { RemoteTarget } from "../../../../../src/renderer/state/stores/remote-view";

const target: RemoteTarget = {
  deviceId: "d1",
  deviceName: "qa-desk",
  workspaceId: "w1",
  workspaceName: "repo",
  path: "/repo",
  tabId: "t1",
  kind: "claude",
  title: "qa",
  cwd: "/repo",
};

const answer = { kind: "answer", itemKey: "a-1" } as const;

interface Seen {
  there: string[][];
  open: LinkedFile[];
  shows: (QuickLookList | null)[];
  toasts: string[];
}

function capture(files: Partial<ChatFiles>) {
  const seen: Seen = { there: [], open: [], shows: [], toasts: [] };
  const all = {
    access: null,
    epoch: 1,
    connection: 1,
    there: async (paths: readonly string[]) => {
      seen.there.push([...paths]);
      return new Set(paths);
    },
    picture: async () => ({ mediaType: "image/png", data: "" }),
    subscribePicture: () => () => {},
    ...files,
  } as ChatFiles;
  if (files.open) {
    const open = files.open;
    all.open = (link, purpose) => {
      seen.open.push(link);
      return open(link, purpose);
    };
  }
  let links: ReturnType<typeof useRemoteLinks> | undefined;
  function CaptureLinks() {
    links = useRemoteLinks(
      target,
      { model: { items: [], tools: {}, agentItems: {} } },
      all,
      (look) => seen.shows.push(look),
      () => true,
    );
    return null;
  }
  renderToStaticMarkup(<CaptureLinks />);
  const stop = watchToasts((toast) => seen.toasts.push(String(toast.message)));
  stops.push(stop);
  if (!links) throw new Error("no links");
  return { links, seen };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a click on a link outside the workspace asks for a grant and opens the path it gives", async () => {
  const { links, seen } = capture({ open: async () => "/outside/qa-a.txt" });
  const link = { href: "../outside/qa-a.txt:12", source: answer };
  links.openFile(link.href, { link });
  await settle();
  expect(seen.open).toEqual([link]);
  expect(seen.there).toEqual([]);
  expect(seen.shows).toEqual([
    { files: ["/outside/qa-a.txt"], index: 0, at: { path: "/outside/qa-a.txt", line: 12 } },
  ]);
});

test("a click on an absolute path inside the workspace reads it directly", async () => {
  const { links, seen } = capture({ open: async () => "/never" });
  links.openFile("/repo/src/a.ts", { link: { href: "/repo/src/a.ts", source: answer } });
  await settle();
  expect(seen.open).toEqual([]);
  expect(seen.shows).toEqual([{ files: ["/repo/src/a.ts"], index: 0 }]);
});

test("an older host resolves the link here, as before", async () => {
  const { links, seen } = capture({});
  links.openFile("/outside/qa-a.txt", { link: { href: "/outside/qa-a.txt", source: answer } });
  await settle();
  expect(seen.open).toEqual([]);
  expect(seen.shows).toEqual([{ files: ["/outside/qa-a.txt"], index: 0 }]);
});

test("a gallery opened from a card grants the card first and keeps its neighbours' links", async () => {
  const { links, seen } = capture({ open: async () => "/outside/qa-1.txt" });
  const one = { href: "qa-1.txt", source: answer };
  const two = { href: "/outside/qa-2.txt", source: answer };
  const gallery = ["/repo/qa-1.txt", "/outside/qa-2.txt"];
  links.openFile(gallery[0], {
    gallery,
    link: one,
    links: { [gallery[0]]: one, [gallery[1]]: two },
  });
  await settle();
  expect(seen.open).toEqual([one]);
  expect(seen.shows).toEqual([
    {
      files: ["/outside/qa-1.txt", "/outside/qa-2.txt"],
      index: 0,
      links: { "/outside/qa-1.txt": one, "/outside/qa-2.txt": two },
      granted: ["/outside/qa-1.txt"],
    },
  ]);
});

test("a link gone from the chat says so and opens nothing", async () => {
  const { links, seen } = capture({
    open: async () => {
      throw new LinkGrantError("gone", "not-found");
    },
  });
  links.openFile("x.txt", { link: { href: "x.txt", source: answer } });
  await settle();
  expect(seen.shows).toEqual([]);
  expect(seen.toasts).toHaveLength(1);
});

test("quick look asks for a grant before it reads a page the user stepped to", () => {
  const opened: LinkedFile[] = [];
  const files = {
    access: null,
    epoch: 1,
    connection: 1,
    there: async (paths: readonly string[]) => new Set(paths),
    picture: async () => ({ mediaType: "image/png", data: "" }),
    subscribePicture: () => () => {},
    resolve: async () => [],
    open: async (link: LinkedFile) => {
      opened.push(link);
      return "/outside/qa-2.txt";
    },
  } as ChatFiles;
  const two = { href: "/outside/qa-2.txt", source: answer };
  const look = (granted: string[]) =>
    renderToStaticMarkup(
      <ChatFilesContext.Provider value={files}>
        <QuickLook
          workspaceId="peer:d1:w1"
          peerRoot="/repo"
          local={false}
          area={null}
          list={{
            files: ["/outside/qa-2.txt"],
            index: 0,
            links: { "/outside/qa-2.txt": two },
            granted,
          }}
          onIndex={() => {}}
          onClose={() => {}}
        />
      </ChatFilesContext.Provider>,
    );
  const body = spyOn(fileLook, "FileLookBody").mockImplementation(() => null);
  try {
    expect(look([])).toContain("Loading");
    expect(body).not.toHaveBeenCalled();
    look(["/outside/qa-2.txt"]);
    expect(body).toHaveBeenCalled();
  } finally {
    body.mockRestore();
  }
});
