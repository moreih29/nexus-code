/**
 * The composer's completion menu with nothing to offer: a command query
 * that matches none says so, unless the program has not listed its
 * commands yet; a file query says nothing.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletionMenu } from "../../../../../src/renderer/components/chat/completion-menu";

const none = (kind: "command" | "file", listing?: boolean) =>
  renderToStaticMarkup(
    <CompletionMenu
      kind={kind}
      items={[]}
      listing={listing}
      active={0}
      onPick={() => {}}
      onHover={() => {}}
    />,
  );

describe("an empty completion menu", () => {
  test("says no command matches", () => {
    expect(none("command")).toContain('data-testid="chat-completion-empty"');
  });

  test("says nothing while the commands are being listed, or for files", () => {
    expect(none("command", true)).toBe("");
    expect(none("file")).toBe("");
  });
});
