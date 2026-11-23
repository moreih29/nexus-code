import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ChatLinks,
  ChatLinksContext,
} from "../../../../../src/renderer/components/chat/chat-links";
import { MessageList } from "../../../../../src/renderer/components/chat/message-list";
import {
  attachedOpens,
  servedAttachment,
} from "../../../../../src/renderer/services/chat/attach-folders";
import { resolveFilePath } from "../../../../../src/renderer/services/chat/links";
import { WINDOW_ITEMS } from "../../../../../src/renderer/services/chat/message-window";
import {
  type ChatItem,
  emptyModel,
  type ToolCall,
  type UserItem,
} from "../../../../../src/renderer/services/chat/model";
import en from "../../../../../src/shared/i18n/locales/en/common.json";

function render(historyTruncated: boolean, count = 1, hasEarlier = false) {
  const items: UserItem[] = Array.from({ length: count }, (_, index) => ({
    kind: "user",
    key: `message-${index}`,
    text: `message ${index}`,
    images: [],
    state: "taken",
  }));
  return renderToStaticMarkup(
    <MessageList
      workspaceId="ws"
      cwd="/p"
      rootPath="/p"
      history={{ ...emptyModel(), items }}
      model={emptyModel()}
      historyTruncated={historyTruncated}
      older={{ hasEarlier, loading: false, load: () => {} }}
    />,
  );
}

test("the missing-history notice is inside the scroll area before the oldest message", () => {
  const html = render(true);
  const scroller = html.indexOf('data-testid="chat-messages"');
  const notice = html.indexOf(en.chat.history_truncated);
  expect(scroller).toBeGreaterThanOrEqual(0);
  expect(notice).toBeGreaterThan(scroller);
  expect(notice).toBeLessThan(html.indexOf("data-chat-row"));
});

test("the notice is absent with complete history or while older messages can still be shown", () => {
  expect(render(false)).not.toContain(en.chat.history_truncated);
  expect(render(true, 1, true)).not.toContain(en.chat.history_truncated);
  expect(render(true, WINDOW_ITEMS + 2)).not.toContain(en.chat.history_truncated);
});

function attachedChips(files: string[], links: ChatLinks) {
  const item: UserItem = {
    kind: "user",
    key: "sent",
    text: `look\n\n${files.map((file) => `@${file}`).join(" ")}`,
    images: [],
    state: "taken",
  };
  const html = renderToStaticMarkup(
    <ChatLinksContext.Provider value={links}>
      <MessageList
        workspaceId="ws"
        cwd="/p"
        rootPath="/p"
        history={null}
        model={{ ...emptyModel(), items: [item] }}
        historyTruncated={false}
        older={{ hasEarlier: false, loading: false, load: () => {} }}
      />
    </ChatLinksContext.Provider>,
  );
  for (const file of files) expect(html).toContain(`title="${file}"`);
  const buttons = [
    ...html.matchAll(/data-testid="chat-attached-image"[^>]*>.*?<span[^>]*>([^<]+)</g),
  ];
  return buttons.map((match) => match[1]).sort();
}

const links: ChatLinks = {
  openFile: () => {},
  openImages: () => {},
  openChange: () => {},
  openUrl: () => {},
};
const ATTACHED = [
  "/Users/me/.nexus-code/attach/w1/c1/2/sent.png",
  "/p/shots/inside.png",
  "/Users/me/Desktop/dropped.png",
];

test("in a chat here, every attached image's chip opens quick look", () => {
  expect(attachedChips(ATTACHED, links)).toEqual(["dropped.png", "inside.png", "sent.png"]);
});

test("in another computer's chat, only the chips of images that computer serves open it", () => {
  const opensAttached = (written: string) => {
    const file = resolveFilePath(written, "/p");
    return file !== null && servedAttachment("w1", "/p", file);
  };
  const before = "/Users/me/.nexus-code/attach/w1/c0/1/before.png";
  const elsewhere = "/Users/me/.nexus-code/attach/w2/c1/1/elsewhere.png";
  expect(attachedChips([...ATTACHED, before, elsewhere], { ...links, opensAttached })).toEqual([
    "before.png",
    "inside.png",
    "sent.png",
  ]);
});

test("in a chat here, the chip of an attached image no longer kept only names it", () => {
  const gone = new Set(["/Users/me/.nexus-code/attach/w1/c1/2/sent.png"]);
  const opensAttached = attachedOpens(gone, "/p");
  expect(attachedChips(ATTACHED, { ...links, opensAttached })).toEqual([
    "dropped.png",
    "inside.png",
  ]);
  expect(
    attachedChips(ATTACHED, { ...links, opensAttached: attachedOpens(new Set(), "/p") }),
  ).toEqual(["dropped.png", "inside.png", "sent.png"]);
});

function transcript(itemsDone: boolean) {
  const items: ChatItem[] = [
    { kind: "user", key: "prompt", text: "look", images: [], state: "taken" },
    {
      kind: "assistant",
      key: "a",
      messageId: "a",
      blocks: [
        { type: "tool", toolUseId: "shot" },
        { type: "text", text: "Here it is" },
      ],
    },
  ];
  const tools: Record<string, ToolCall> = {
    shot: {
      id: "shot",
      name: "Screenshot",
      input: {},
      status: "done",
      parentToolUseId: "agent",
      result: { text: "", isError: false, images: [{ mediaType: "image/png", data: "AAAA" }] },
    },
  };
  return renderToStaticMarkup(
    <MessageList
      workspaceId="ws"
      cwd="/p"
      rootPath="/p"
      history={null}
      model={{ ...emptyModel(), tools }}
      items={items}
      itemsDone={itemsDone}
    />,
  );
}

test("a subagent's answer ends with what its calls gave once it ended, as a turn's does", () => {
  expect(transcript(true)).toContain('data-testid="chat-answer-extras"');
  expect(transcript(false)).not.toContain('data-testid="chat-answer-extras"');
});
