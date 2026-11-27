import { describe, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../../../../../src/renderer/components/chat/chat-markdown";
import {
  type ChatFiles,
  ChatFilesContext,
  FileLinkSourceContext,
  type LinkedFile,
} from "../../../../../src/renderer/services/chat/chat-files";
import { resolveFilePath } from "../../../../../src/renderer/services/chat/links";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  answerExtras,
  answerLinks,
  distinctResults,
  outsideLinkedFiles,
  outsideLinksOf,
  resultHref,
  resultsOf,
} from "../../../../../src/renderer/services/chat/panel";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { linkCandidates } from "../../../../../src/renderer/services/cli/file-links";
import {
  cleanLinkHref,
  linkDestination,
  linkTargetsIn,
  textLinksTo,
} from "../../../../../src/shared/chat/link-text";
import { isNetworkLink, networkLinkPath } from "../../../../../src/shared/fs/outside-url";
import { withTestDom } from "../../../../helpers/test-dom";

const CWD = "/w";
const ANSWER = { kind: "answer", itemKey: "a1" } as const;

interface Row {
  written: string;
  shown: string;
  sent: string;
  path: string;
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
    written: String.raw`C:\x\.y.png "t"`,
    shown: String.raw`C:\x\.y.png`,
    sent: String.raw`C:\x\.y.png`,
    path: "C:/x/.y.png",
  },
  {
    written: String.raw`C:\x\.y.png 't'`,
    shown: String.raw`C:\x\.y.png`,
    sent: String.raw`C:\x\.y.png`,
    path: "C:/x/.y.png",
  },
  {
    written: String.raw`C:\x\.y.png (t)`,
    shown: String.raw`C:\x\.y.png`,
    sent: String.raw`C:\x\.y.png`,
    path: "C:/x/.y.png",
  },
  {
    written: `${String.raw`C:\x\.y.png`}\n"multi\nline"`,
    shown: String.raw`C:\x\.y.png`,
    sent: String.raw`C:\x\.y.png`,
    path: "C:/x/.y.png",
  },
  {
    written: String.raw`  C:\x\.y.png  `,
    shown: String.raw`C:\x\.y.png`,
    sent: String.raw`C:\x\.y.png`,
    path: "C:/x/.y.png",
  },
  {
    written: String.raw`C:\x(1)\.y.png`,
    shown: String.raw`C:\x(1)\.y.png`,
    sent: String.raw`C:\x(1)\.y.png`,
    path: "C:/x(1)/.y.png",
  },
  {
    written: String.raw`C:\x\)y.png`,
    shown: String.raw`C:\x\)y.png`,
    sent: String.raw`C:\x\)y.png`,
    path: "C:/x/)y.png",
  },
  {
    written: String.raw`C:\a&amp;b.txt`,
    shown: String.raw`C:\a&b.txt`,
    sent: String.raw`C:\a&amp;b.txt`,
    path: "C:/a&b.txt",
  },
  {
    written: String.raw`C&#58;\x\.y.png`,
    shown: String.raw`C:\x.y.png`,
    sent: String.raw`C&#58;\x\.y.png`,
    path: "C:/x.y.png",
  },
  {
    written: "/home/me/.config/a.png",
    shown: "/home/me/.config/a.png",
    sent: "/home/me/.config/a.png",
    path: "/home/me/.config/a.png",
  },
  {
    written: String.raw`/home/me/\_x/a.png "t"`,
    shown: "/home/me/_x/a.png",
    sent: String.raw`/home/me/\_x/a.png`,
    path: "/home/me/_x/a.png",
  },
];

const NETWORK: Omit<Row, "path">[] = [
  {
    written: String.raw`\\server\share\.x\a.png`,
    shown: String.raw`\\server\share\.x\a.png`,
    sent: String.raw`\\server\share\.x\a.png`,
  },
  {
    written: String.raw`<\\server\share\.x\a.png> "t"`,
    shown: String.raw`\\server\share\.x\a.png`,
    sent: String.raw`\\server\share\.x\a.png`,
  },
  {
    written: String.raw`\\\\server\\share\\a.png`,
    shown: String.raw`\\\\server\\share\\a.png`,
    sent: String.raw`\\\\server\\share\\a.png`,
  },
  {
    written: String.raw`/\\server/share/a.png`,
    shown: String.raw`/\\server/share/a.png`,
    sent: String.raw`/\\server/share/a.png`,
  },
  {
    written: String.raw`\/\/server/share/a.png`,
    shown: String.raw`\/\/server/share/a.png`,
    sent: String.raw`\/\/server/share/a.png`,
  },
  {
    written: String.raw`\\.\C:\a\.b.png`,
    shown: String.raw`\\.\C:\a\.b.png`,
    sent: String.raw`\\.\C:\a\.b.png`,
  },
  {
    written: String.raw`\\?\C:\a\.b.png`,
    shown: String.raw`\\?\C:\a\.b.png`,
    sent: String.raw`\\?\C:\a\.b.png`,
  },
  {
    written: "//server/share/.x/a.png",
    shown: "//server/share/.x/a.png",
    sent: "//server/share/.x/a.png",
  },
  {
    written: String.raw`&#92;&#92;srv\sh\.x\a.png`,
    shown: String.raw`\\srv\sh.x\a.png`,
    sent: String.raw`&#92;&#92;srv\sh\.x\a.png`,
  },
  {
    written: "file://127.0.0.1/qa/z.png",
    shown: "file://127.0.0.1/qa/z.png",
    sent: "file://127.0.0.1/qa/z.png",
  },
];

function answerOf(written: string, image = false): string {
  return `See ${image ? "!" : ""}[a](${written}).`;
}

function decodedTitle(title: string): string {
  return decodeURIComponent(title.replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
}

function localHrefs(text: string): string[] {
  const html = renderToStaticMarkup(
    <ChatMarkdown text={text} workspaceId="ws" cwd={CWD} rootPath={CWD} />,
  );
  return [...html.matchAll(/<(?:a|span)\b[^>]*\btitle="([^"]*)"/g)].map((match) =>
    decodedTitle(match[1] as string),
  );
}

function hostFiles(asked: LinkedFile[]): ChatFiles {
  return {
    access: { scope: "s", signal: new AbortController().signal },
    epoch: 1,
    connection: 1,
    there: async (paths: readonly string[]) => new Set(paths),
    gone: async () => new Set<string>(),
    picture: async () => ({ type: "image", mediaType: "image/png", data: "" }) as never,
    subscribePicture: () => () => {},
    resolve: async (links: readonly LinkedFile[]) => {
      asked.push(...links);
      return links.map(() => null);
    },
    open: async () => "",
  };
}

function Remote({ text, files }: { text: string; files: ChatFiles }) {
  return (
    <ChatFilesContext.Provider value={files}>
      <FileLinkSourceContext.Provider value={ANSWER}>
        <ChatMarkdown text={text} workspaceId="ws" cwd={CWD} rootPath={CWD} />
      </FileLinkSourceContext.Provider>
    </ChatFilesContext.Provider>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function remoteSent(text: string): Promise<string[]> {
  const asked: LinkedFile[] = [];
  const files = hostFiles(asked);
  await withTestDom(async (_host, view) => {
    await act(async () => view.render(<Remote text={text} files={files} />));
    await settle();
  });
  return asked.map((link) => link.href);
}

function itemsOf(text: string) {
  return [
    { kind: "user", key: "u1", text: "go", images: [], state: "taken" },
    { kind: "assistant", key: ANSWER.itemKey, messageId: "m1", blocks: [{ type: "text", text }] },
  ] as never;
}

function candidates(text: string, href: string): string[] | null {
  const chat = { ...emptyTabState(), model: { ...emptyModel(), items: itemsOf(text) } };
  return linkCandidates({ agent: "claude", title: "c", chat } as never, CWD, href, ANSWER);
}

describe("a path link reads the same in every consumer", () => {
  test.each(FILES)("$written", async ({ written, shown, sent, path }) => {
    const text = answerOf(written);
    const image = answerOf(written, true);
    const local = localHrefs(text);
    expect(local).toEqual([shown]);
    expect(resolveFilePath(shown, CWD)).toBe(path);
    expect(await remoteSent(text)).toEqual([sent]);
    expect(await remoteSent(image)).toEqual(path.endsWith(".png") ? [sent] : []);
    expect(textLinksTo(text, sent)).toBe(true);
    expect(resolveFilePath(cleanLinkHref(sent), CWD)).toBe(path);
    expect(candidates(text, sent)).toEqual([path]);
    const results = resultsOf(itemsOf(text), {}, CWD);
    expect(results.map(resultHref)).toEqual([sent]);
    expect(results.map((result) => resolveFilePath(result.target, CWD))).toEqual([path]);
    expect(outsideLinkedFiles(itemsOf(text), {}, CWD, CWD)).toEqual([path]);
    expect(outsideLinksOf(itemsOf(image), {}, CWD, CWD).files).toEqual(
      path.endsWith(".png") ? [path] : [],
    );
  });
});

describe("a network or device path link goes through the network checks in every consumer", () => {
  test.each(NETWORK)("$written", async ({ written, shown, sent }) => {
    const text = answerOf(written);
    const local = localHrefs(text);
    expect(local).toEqual([shown]);
    expect(isNetworkLink(shown)).toBe(true);
    expect(await remoteSent(text)).toEqual([sent]);
    expect(isNetworkLink(cleanLinkHref(sent))).toBe(true);
    expect(textLinksTo(text, sent)).toBe(true);
    const network = networkLinkPath(cleanLinkHref(sent));
    expect(network).not.toBeNull();
    expect(candidates(text, sent)).toEqual([network as string]);
    expect(isNetworkLink(network as string)).toBe(true);
    expect(outsideLinksOf(itemsOf(answerOf(written, true)), {}, CWD, CWD).files).toEqual([]);
  });

  test.each([
    [String.raw`\\server\share\x.png`, "//server/share/x.png"],
    ["//server/share/x.png", "//server/share/x.png"],
    [String.raw`\\?\C:\x.png`, "//?/C:/x.png"],
    [String.raw`\\.\C:\x.png`, "//./C:/x.png"],
    [String.raw`\/server/share/x.png`, "//server/share/x.png"],
    [String.raw`/\server\share\x.png`, "//server/share/x.png"],
    ["file://server/share/x.png", "//server/share/x.png"],
  ])("the host's candidate for %s stays the network path %s, never a local one", (href, place) => {
    expect(candidates(answerOf(href), href)).toEqual([place]);
  });
});

describe("a link the old pattern misread is read where Markdown reads it", () => {
  test.each([
    {
      text: `${String.raw`[r]: C:\ok](C:\Users\me\.ssh\id.png)`}\n\nSee [x][r].`,
      target: String.raw`C:\ok](C:\Users\me\.ssh\id.png)`,
      wrong: String.raw`C:\Users\me\.ssh\id.png`,
    },
    {
      text: `${String.raw`[r]: C:\ok](\\evil\s\a.png)`}\n\nSee [x][r].`,
      target: String.raw`C:\ok](\\evil\s\a.png)`,
      wrong: String.raw`\\evil\s\a.png`,
    },
    {
      text: String.raw`See [a](C:\x(1) "](C:\Users\me\.ssh\id.png").`,
      target: String.raw`C:\x(1)`,
      wrong: String.raw`C:\Users\me\.ssh\id.png"`,
    },
    {
      text: 'See [a](/tmp/x(1) "](/etc/passwd").',
      target: "/tmp/x(1)",
      wrong: '/etc/passwd"',
    },
  ])("$text", async ({ text, target, wrong }) => {
    expect(localHrefs(text)).toEqual([target]);
    expect(await remoteSent(text)).toEqual([target]);
    expect(linkTargetsIn(text)).toEqual([target]);
    expect(textLinksTo(text, wrong)).toBe(false);
    expect(resultsOf(itemsOf(text), {}, CWD).map(resultHref)).toEqual([target]);
  });
});

describe("a reference link sends its definition as written", () => {
  const definition = String.raw`[r]: C:\x\.y.png:12`;
  test.each([
    ["See [a][r].", false],
    ["See ![a][r].", true],
    ["See [r].", false],
    ["See [r][].", false],
    ["See [A][R].", false],
  ] as const)("%s", async (use, image) => {
    const text = `${use}\n\n${definition}`;
    expect(localHrefs(text)).toEqual(image ? [] : [String.raw`C:\x\.y.png:12`]);
    expect(await remoteSent(text)).toEqual([String.raw`C:\x\.y.png`]);
    expect(textLinksTo(text, String.raw`C:\x\.y.png`)).toBe(true);
    const results = resultsOf(itemsOf(text), {}, CWD);
    expect(results.map(resultHref)).toEqual([String.raw`C:\x\.y.png`]);
    expect(outsideLinksOf(itemsOf(text), {}, CWD, CWD).files).toEqual(["C:/x/.y.png"]);
  });

  test("a definition nothing uses is no link", () => {
    const text = `Nothing here.\n\n${definition}`;
    expect(linkTargetsIn(text)).toEqual([]);
    expect(resultsOf(itemsOf(text), {}, CWD)).toEqual([]);
    expect(outsideLinksOf(itemsOf(text), {}, CWD, CWD).files).toEqual([]);
  });
});

describe("a link inside code is no link to any consumer", () => {
  const link = String.raw`[a](C:\x\.y.png)`;
  test.each([
    ["a fenced block", `\`\`\`\n${link}\n\`\`\``, []],
    ["a tilde fence", `~~~md\n${link}\n~~~`, []],
    ["an unclosed fence while streaming", `\`\`\`\n${link}`, []],
    ["an indented fence", `   \`\`\`\n${link}\n   \`\`\``, []],
    ["a fence in a list item", `- item\n\n  \`\`\`\n  ${link}\n  \`\`\``, []],
    ["a code span", `See \`${link}\`.`, []],
    ["a double backtick span", `See \`\` ${link} \` \`\`.`, []],
    ["a link beside a code span", `See \`code\` ${link} \`more\`.`, [String.raw`C:\x\.y.png`]],
    ["a link after a fence", `\`\`\`\ncode\n\`\`\`\n\n${link}`, [String.raw`C:\x\.y.png`]],
    ["a lone backtick", `See \` ${link}.`, [String.raw`C:\x\.y.png`]],
  ] as const)("%s", (_name, text, targets) => {
    expect(localHrefs(text)).toEqual([...targets]);
    expect(linkTargetsIn(text)).toEqual([...targets]);
    expect(resultsOf(itemsOf(text), {}, CWD).map((result) => result.target)).toEqual(
      targets.map(linkDestination),
    );
    const image = text.replace("[a](", "![a](");
    expect(outsideLinksOf(itemsOf(image), {}, CWD, CWD).files).toEqual(
      targets.length > 0 ? ["C:/x/.y.png"] : [],
    );
  });
});

describe("the hrefs a chat's cards send", () => {
  test("keep the written target through answerExtras and distinctResults", () => {
    const text = String.raw`Made [a](C:\x\.y.txt) and [b](C:/x/.y.txt).`;
    const results = resultsOf(itemsOf(text), {}, CWD);
    const [kept] = distinctResults(results, CWD);
    expect(kept && resultHref(kept)).toBe(String.raw`C:\x\.y.txt`);
    const extras = [...answerExtras(itemsOf(text), {}, CWD, CWD, true, true).values()];
    const links = extras.flatMap((extra) => Object.values(answerLinks(extra)));
    expect(links.map((linked) => linked.href)).toContain(String.raw`C:\x\.y.txt`);
  });
});

describe("a streaming answer", () => {
  test("keeps its links and images mounted while text is added", async () => {
    const asked: LinkedFile[] = [];
    const files = hostFiles(asked);
    const first = String.raw`See [a](C:\x\.y.txt) and ![i](C:\x\.z.png) and [w](https://example.com/a).`;
    await withTestDom(async (host, view) => {
      await act(async () => view.render(<Remote text={first} files={files} />));
      await settle();
      const before = [...host.querySelectorAll("a, span, img")];
      const askedBefore = asked.length;
      for (const more of [" More", " More text", " More text and more."]) {
        await act(async () => view.render(<Remote text={first + more} files={files} />));
        await settle();
      }
      const after = [...host.querySelectorAll("a, span, img")].slice(0, before.length);
      expect(before.length).toBeGreaterThan(0);
      expect(after.map((element, i) => element === before[i])).toEqual(before.map(() => true));
      expect(asked.length).toBe(askedBefore);
    });
  });
});

describe("a link that is not a path keeps CommonMark and the scheme rules", () => {
  test.each([
    ["https://example.com/a\\_b", "https://example.com/a_b"],
    ["https://example.com/a%20b", "https://example.com/a b"],
  ])("%s", async (written, shown) => {
    expect(localHrefs(answerOf(written))).toEqual([shown]);
    expect(await remoteSent(answerOf(written))).toEqual([]);
  });

  test.each([
    "javascript:alert%281%29",
    "data:text/html,%3Cscript%3Ealert(1)%3C/script%3E",
    "vbscript:msgbox(1)",
    String.raw`javascript:alert(1)\\C:\a`,
    "<javascript:alert(1)>",
    "javascript&#58;alert(1)",
  ])("%s", async (written) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={answerOf(written)} workspaceId="ws" cwd={CWD} rootPath={CWD} />,
    );
    expect(html).not.toMatch(/javascript|data:|vbscript/i);
    expect(await remoteSent(answerOf(written))).toEqual([]);
  });
});
