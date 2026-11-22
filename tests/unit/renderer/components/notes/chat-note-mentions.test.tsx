import { expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import {
  Composer,
  type ComposerController,
} from "../../../../../src/renderer/components/chat/composer";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import * as chatNotes from "../../../../../src/renderer/services/notes/chat-notes";
import * as voice from "../../../../../src/renderer/services/voice/availability";
import { withTestDom } from "../../../../helpers/test-dom";

test("picking an @ note removes the query and restores the chip when sending fails", async () => {
  const scope = spyOn(chatNotes, "useChatNotes").mockReturnValue({
    chat: { workspaceId: "workspace", tabId: "tab", agent: "claude" },
    location: "workspace",
    notes: [{ noteId: "n1234567", title: "Review", updatedAt: 1 }],
  });
  const recent = spyOn(chatNotes, "useRecentChatNotes").mockReturnValue([]);
  const availability = spyOn(voice, "useVoiceAvailability").mockReturnValue("unavailable");
  const sending = Promise.withResolvers<void>();
  const send = mock(() => sending.promise);
  const controller: ComposerController = {
    key: "workspace:tab",
    send,
    enqueue: () => {},
    removeQueued: () => undefined,
    interrupt: async () => {},
    clearDraft: () => {},
    attach: async () => "",
    fileSuggestions: async () => [],
    supports: () => false,
    setPermissionMode: async () => {},
    setModel: async () => {},
    setEffort: async () => {},
  };
  const dispatch = (node: Element, type: string) => {
    const event = document.createEvent("Event");
    event.initEvent(type, true, true);
    node.dispatchEvent(event);
  };
  try {
    await withTestDom(async (host, root) => {
      await act(async () =>
        root.render(<Composer controller={controller} state={emptyTabState()} local />),
      );
      const area = host.querySelector("textarea")!;
      await act(async () => dispatch(area, "focusin"));
      for (const text of ["Read ", "Read @", "Read @rev"]) {
        await act(async () => {
          const value = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value");
          value?.set?.call(area, text);
          area.setSelectionRange(text.length, text.length);
          dispatch(area, "input");
        });
      }
      const choice = host.querySelector<HTMLElement>('[role="option"]');
      expect(choice?.textContent).toContain("Review");
      await act(async () => {
        choice?.click();
      });
      const chip = () => host.querySelector('[data-testid="chat-note-mention"]');
      expect(chip()?.textContent).toBe("Review");
      expect(area.value).toBe("Read ");
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click();
      });
      expect(send).toHaveBeenCalledWith("Read\n\nNote ‘Review’: `nexus note read n1234567`", []);
      expect(chip()).toBeFalsy();
      await act(async () => sending.reject(new Error("Send failed")));
      expect(chip()?.textContent).toBe("Review");
      expect(area.value).toBe("Read ");
    });
  } finally {
    scope.mockRestore();
    recent.mockRestore();
    availability.mockRestore();
  }
});
