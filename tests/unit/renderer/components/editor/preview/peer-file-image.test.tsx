import { expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ChatLinks,
  ChatLinksContext,
} from "../../../../../../src/renderer/components/chat/chat-links";
import { MarkdownPreview } from "../../../../../../src/renderer/components/editor/preview/markdown-preview";
import { PeerFileImage } from "../../../../../../src/renderer/components/editor/preview/peer-file-image";
import {
  type ChatFiles,
  ChatFilesContext,
  type LinkedFile,
  LinkGrantError,
} from "../../../../../../src/renderer/services/chat/chat-files";
import type { ImageBlock } from "../../../../../../src/renderer/services/chat/model";
import { peerWorkspaceId } from "../../../../../../src/renderer/services/remote/peer-workspace";
import { withTestDom } from "../../../../../helpers/test-dom";

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

function imageIn(files: ChatFiles, links: ChatLinks | null) {
  return (
    <ChatFilesContext.Provider value={files}>
      <ChatLinksContext.Provider value={links}>
        <PeerFileImage
          path="/outside/qa/shot.png"
          href="shot.png"
          parent="/outside/qa/notes.md"
          alt="shot"
          fallback={<span data-testid="qa-unread">unread</span>}
        />
      </ChatLinksContext.Provider>
    </ChatFilesContext.Provider>
  );
}

test("an image in an opened file is read first and shown", async () => {
  const image: ImageBlock = { mediaType: "image/png", data: "AAA" };
  const files = chatFiles({ picture: async () => image, open: async () => "/never" });
  await withTestDom(async (host, root) => {
    await act(async () => root.render(imageIn(files, null)));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });
  expect(files.opened).toEqual([]);
});

test("an image that needs a grant becomes a tile, and a click grants it from the file", async () => {
  const files = chatFiles({
    picture: async () => {
      throw new LinkGrantError("a grant is required", "grant-required");
    },
    open: async () => "/outside/qa/shot.png",
  });
  const asked: [string, unknown][] = [];
  const links = {
    openFile: (target: string, options?: unknown) => asked.push([target, options]),
    openImages: () => {},
    openChange: () => {},
    openUrl: () => {},
  } as ChatLinks;
  await withTestDom(async (host, root) => {
    await act(async () => root.render(imageIn(files, links)));
    const tile = host.querySelector<HTMLButtonElement>('[data-testid="chat-image-chip"]');
    expect(tile).toBeTruthy();
    expect(host.querySelector("img")).toBeFalsy();
    await act(async () => tile?.click());
  });
  expect(files.opened).toEqual([]);
  expect(asked).toEqual([
    [
      "/outside/qa/shot.png",
      { link: { href: "shot.png", source: { kind: "file", parent: "/outside/qa/notes.md" } } },
    ],
  ]);
});

test("an image that fails for another reason shows the read failure", async () => {
  const files = chatFiles({
    picture: async () => {
      throw new LinkGrantError("offline", "unavailable");
    },
  });
  await withTestDom(async (host, root) => {
    await act(async () => root.render(imageIn(files, null)));
    expect(host.querySelector('[data-testid="qa-unread"]')).toBeTruthy();
  });
});

test("an opened Markdown file from a grants host reads an image out of the workspace itself", () => {
  const md = (files: ChatFiles) =>
    renderToStaticMarkup(
      <ChatFilesContext.Provider value={files}>
        <MarkdownPreview
          source="![shot](../../qa/shot.png)"
          workspaceId={peerWorkspaceId("d1", "w1")}
          currentFileAbsPath="/repo/docs/a.md"
          workspaceRootAbsPath="/repo"
        />
      </ChatFilesContext.Provider>,
    );
  const grants = chatFiles({ resolve: async () => [], open: async () => "/never" });
  expect(md(grants)).toContain("peer-file-image-pending");
  expect(md(chatFiles())).not.toContain("peer-file-image-pending");
});
