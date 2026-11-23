import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ChatLinks,
  ChatLinksContext,
} from "../../../../../src/renderer/components/chat/chat-links";
import { MessageList } from "../../../../../src/renderer/components/chat/message-list";
import { servedAttachment } from "../../../../../src/renderer/services/chat/attach-folders";
import { resolveFilePath } from "../../../../../src/renderer/services/chat/links";
import { WINDOW_ITEMS } from "../../../../../src/renderer/services/chat/message-window";
import { emptyModel, type UserItem } from "../../../../../src/renderer/services/chat/model";
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

/** The chips of a message that attached `files`, under `links`: which open quick look. */
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
  // Each shows as a chip of its name, a button or not.
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
  // As remote-links answers for that computer's workspace w1 at /p and its tab c1.
  const opensAttached = (written: string) => {
    const file = resolveFilePath(written, "/p");
    return file !== null && servedAttachment("w1", "c1", "/p", file);
  };
  expect(attachedChips(ATTACHED, { ...links, opensAttached })).toEqual(["inside.png", "sent.png"]);
});
