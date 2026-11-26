import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../../../../../src/renderer/components/chat/chat-markdown";
import {
  type ChatFiles,
  ChatFilesContext,
  FileLinkSourceContext,
} from "../../../../../src/renderer/services/chat/chat-files";
import { resolveFilePath } from "../../../../../src/renderer/services/chat/links";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  outsideLinkedFiles,
  outsideLinksOf,
  resultHref,
  resultsOf,
} from "../../../../../src/renderer/services/chat/panel";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { linkCandidates } from "../../../../../src/renderer/services/cli/file-links";
import { cleanLinkHref, textLinksTo } from "../../../../../src/shared/chat/link-text";
import { isNetworkLink } from "../../../../../src/shared/fs/outside-url";

const CWD = "/w";
const ANSWER = { kind: "answer", itemKey: "a1" } as const;

interface Row {
  written: string;
  shown: string;
  sent: string;
  path: string | null;
}

const FILES: Row[] = [
  {
    written: String.raw`C:\Users\me\.claude\a.png`,
    shown: String.raw`C:\Users\me\.claude\a.png`,
    sent: String.raw`C:\Users\me\.claude\a.png`,
    path: "C:/Users/me/.claude/a.png",
  },
  {
    written: String.raw`C:\a\_b\c-d.txt`,
    shown: String.raw`C:\a\_b\c-d.txt`,
    sent: String.raw`C:\a\_b\c-d.txt`,
    path: "C:/a/_b/c-d.txt",
  },
  {
    written: String.raw`C:\a\-b.txt`,
    shown: String.raw`C:\a\-b.txt`,
    sent: String.raw`C:\a\-b.txt`,
    path: "C:/a/-b.txt",
  },
  {
    written: "C:/a/.b/c.txt",
    shown: "C:/a/.b/c.txt",
    sent: "C:/a/.b/c.txt",
    path: "C:/a/.b/c.txt",
  },
  {
    written: String.raw`C:/a\.b/c.txt`,
    shown: String.raw`C:/a\.b/c.txt`,
    sent: String.raw`C:/a\.b/c.txt`,
    path: "C:/a/.b/c.txt",
  },
  {
    written: String.raw`C:\a\b.txt`,
    shown: String.raw`C:\a\b.txt`,
    sent: String.raw`C:\a\b.txt`,
    path: "C:/a/b.txt",
  },
  {
    written: String.raw`<C:\a b\.c.txt>`,
    shown: String.raw`C:\a b\.c.txt`,
    sent: String.raw`C:\a b\.c.txt`,
    path: "C:/a b/.c.txt",
  },
  {
    written: String.raw`C:\a\.b\c.txt:12`,
    shown: String.raw`C:\a\.b\c.txt:12`,
    sent: String.raw`C:\a\.b\c.txt`,
    path: "C:/a/.b/c.txt",
  },
  {
    written: "/home/me/.config/a.png",
    shown: "/home/me/.config/a.png",
    sent: "/home/me/.config/a.png",
    path: "/home/me/.config/a.png",
  },
  {
    written: String.raw`/home/me/\_x/a.png`,
    shown: "/home/me/_x/a.png",
    sent: String.raw`/home/me/\_x/a.png`,
    path: "/home/me/_x/a.png",
  },
];

const NETWORK: Row[] = [
  {
    written: String.raw`\\server\share\.x\a.png`,
    shown: String.raw`\\server\share\.x\a.png`,
    sent: String.raw`\\server\share\.x\a.png`,
    path: null,
  },
  {
    written: String.raw`<\\server\share\.x\a.png>`,
    shown: String.raw`\\server\share\.x\a.png`,
    sent: String.raw`\\server\share\.x\a.png`,
    path: null,
  },
  {
    written: String.raw`\\\\server\\share\\a.png`,
    shown: String.raw`\\\\server\\share\\a.png`,
    sent: String.raw`\\\\server\\share\\a.png`,
    path: null,
  },
  {
    written: String.raw`/\\server/share/a.png`,
    shown: String.raw`/\\server/share/a.png`,
    sent: String.raw`/\\server/share/a.png`,
    path: null,
  },
  {
    written: String.raw`\/\/server/share/a.png`,
    shown: String.raw`\/\/server/share/a.png`,
    sent: String.raw`\/\/server/share/a.png`,
    path: null,
  },
  {
    written: String.raw`\\.\C:\a\.b.txt`,
    shown: String.raw`\\.\C:\a\.b.txt`,
    sent: String.raw`\\.\C:\a\.b.txt`,
    path: null,
  },
  {
    written: "//server/share/.x/a.png",
    shown: "//server/share/.x/a.png",
    sent: "//server/share/.x/a.png",
    path: null,
  },
];

const ALL = [...FILES, ...NETWORK];

function answerOf(written: string, image = false): string {
  return `See ${image ? "!" : ""}[a](${written}).`;
}

function titleIn(html: string): string | null {
  const found = /<(?:a|span)\b[^>]*\btitle="([^"]*)"/.exec(html);
  return found ? found[1].replace(/&amp;/g, "&") : null;
}

function localHref(written: string): string | null {
  const title = titleIn(
    renderToStaticMarkup(
      <ChatMarkdown text={answerOf(written)} workspaceId="ws" cwd={CWD} rootPath={CWD} />,
    ),
  );
  return title === null ? null : decodeURIComponent(title);
}

const hostFiles = {
  access: null,
  epoch: 1,
  connection: 1,
  there: async (paths: readonly string[]) => new Set(paths),
  picture: async () => ({ mediaType: "image/png", data: "" }),
  subscribePicture: () => () => {},
  resolve: async () => [],
  open: async () => "",
} as unknown as ChatFiles;

function remoteHref(written: string): string | null {
  const html = renderToStaticMarkup(
    <ChatFilesContext.Provider value={hostFiles}>
      <FileLinkSourceContext.Provider value={ANSWER}>
        <ChatMarkdown text={answerOf(written)} workspaceId="ws" cwd={CWD} rootPath={CWD} />
      </FileLinkSourceContext.Provider>
    </ChatFilesContext.Provider>,
  );
  return html.includes("<span title=") ? titleIn(html) : null;
}

function itemsOf(text: string) {
  return [
    {
      kind: "assistant",
      key: ANSWER.itemKey,
      messageId: "m1",
      blocks: [{ type: "text", text }],
    },
  ] as never;
}

function candidates(text: string, href: string): string[] | null {
  const chat = { ...emptyTabState(), model: { ...emptyModel(), items: itemsOf(text) } };
  return linkCandidates({ agent: "claude", title: "c", chat } as never, CWD, href, ANSWER);
}

describe("a Windows path link reads the same in every consumer", () => {
  test.each(FILES)("$written", ({ written, shown, sent, path }) => {
    const text = answerOf(written);
    const local = localHref(written);
    expect(local).toBe(shown);
    expect(resolveFilePath(local ?? "", CWD)).toBe(path);
    expect(remoteHref(written)).toBe(sent);
    expect(textLinksTo(text, sent)).toBe(true);
    expect(resolveFilePath(cleanLinkHref(sent), CWD)).toBe(path);
    expect(candidates(text, sent)).toEqual([path as string]);
    const [result] = resultsOf(itemsOf(text), {}, CWD);
    expect(resultHref(result)).toBe(sent);
    expect(resolveFilePath(result.target, CWD)).toBe(path);
    expect(outsideLinkedFiles(itemsOf(text), {}, CWD, CWD)).toEqual([path as string]);
    const images = outsideLinksOf(itemsOf(answerOf(written, true)), {}, CWD, CWD).files;
    expect(images).toEqual(path?.endsWith(".png") ? [path] : []);
  });
});

describe("a network or device path link stays blocked in every consumer", () => {
  test.each(NETWORK)("$written", ({ written, shown, sent }) => {
    const text = answerOf(written);
    const local = localHref(written);
    expect(local).toBe(shown);
    expect(isNetworkLink(local ?? "")).toBe(true);
    expect(remoteHref(written)).toBe(sent);
    expect(isNetworkLink(sent)).toBe(true);
    expect(isNetworkLink(cleanLinkHref(sent))).toBe(true);
    expect(textLinksTo(text, sent)).toBe(true);
    for (const place of candidates(text, sent) ?? []) expect(isNetworkLink(place)).toBe(false);
    expect(outsideLinksOf(itemsOf(answerOf(written, true)), {}, CWD, CWD).files).toEqual([]);
  });
});

describe("a link that is not a path keeps CommonMark and the scheme rules", () => {
  test.each([
    ["https://example.com/a\\_b", "https://example.com/a_b"],
    ["https://example.com/a%20b", "https://example.com/a b"],
  ])("%s", (written, shown) => {
    expect(localHref(written)).toBe(shown);
    expect(remoteHref(written)).toBeNull();
  });

  test.each([
    "javascript:alert%281%29",
    "data:text/html,%3Cscript%3Ealert(1)%3C/script%3E",
    "vbscript:msgbox(1)",
    String.raw`javascript:alert(1)\\C:\a`,
    "<javascript:alert(1)>",
  ])("%s", (written) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={answerOf(written)} workspaceId="ws" cwd={CWD} rootPath={CWD} />,
    );
    expect(html).not.toMatch(/javascript:|data:|vbscript:/i);
    expect(remoteHref(written)).toBeNull();
  });

  test("every row is checked once", () => {
    expect(new Set(ALL.map((row) => row.written)).size).toBe(ALL.length);
  });
});
