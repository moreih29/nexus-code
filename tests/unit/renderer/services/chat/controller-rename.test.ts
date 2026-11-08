/**
 * The session's name, as Claude says it has one: /rename, the tab's own
 * rename, or a named session taken up again. The tab takes it as the
 * user's name for it, and does not send it back.
 */

import { describe, expect, test } from "bun:test";
import { ChatController } from "../../../../../src/renderer/services/chat/controller";
import type { ChatLine } from "../../../../../src/renderer/services/chat/model";

let seq = 0;
const titled = (title: string, replay = false): ChatLine => ({
  seq: ++seq,
  dir: "out",
  message: { type: "system", subtype: "session_title_changed", title, session_id: "s1" },
  ...(replay ? { replay: true } : {}),
});

function controller() {
  const names: string[] = [];
  const c = new ChatController(
    { workspaceId: "ws-rename", tabId: `t${++seq}`, cwd: "/p", sessionId: "s1" },
    { onRename: (title) => names.push(title) },
  );
  return { c, names };
}

describe("session_title_changed", () => {
  test("names the tab once per new name", () => {
    const { c, names } = controller();
    c.receive(titled("  My work "));
    c.receive(titled("My work"));
    c.receive(titled("Other"));
    expect(names).toEqual(["My work", "Other"]);
    c.dispose();
  });

  test("a replayed line is the past: it names nothing", () => {
    const { c, names } = controller();
    c.receive(titled("Old", true));
    expect(names).toEqual([]);
    c.dispose();
  });

  test("the tab's name taken from the session is not sent back", async () => {
    const { c } = controller();
    c.receive(titled("My work"));
    // No program runs here: a rename that went on would have to start one.
    expect(await c.renameSession("My work")).toBe(true);
    c.dispose();
  });
});
