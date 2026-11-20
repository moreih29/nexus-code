import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../../../../../src/renderer/components/chat/message-list";
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
