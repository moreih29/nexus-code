import { expect, mock, test } from "bun:test";
import { act } from "react";
import { NoteTab } from "../../../../../src/renderer/components/notes/note-tab";
import { dropTranscript } from "../../../../../src/renderer/services/notes/transcripts";
import { EMPTY_TRANSCRIPT } from "../../../../../src/shared/notes/transcript";
import type { NoteContent } from "../../../../../src/shared/notes/types";
import { withTestDom } from "../../../../helpers/test-dom";

test("the first note opens its editor after the note is read", async () => {
  const workspaceId = "lazy-note-workspace";
  const noteId = "n1234567";
  const note: NoteContent = {
    id: noteId,
    title: "First opened note",
    createdAt: 1,
    updatedAt: 1,
    counts: { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 },
    excerpt: "Note body",
    dir: "/notes/n1234567",
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Note body" }] }],
    },
  };
  const read = Promise.withResolvers<NoteContent>();
  // The note's recorder controls start the app-wide voice availability watch, which
  // keeps its first answer. Answer as the recorder tests' own window does, so a test
  // file run after this one finds the same signed-in, voice-ready state.
  const answers: Record<string, unknown> = {
    readTranscript: EMPTY_TRANSCRIPT,
    account: { status: "signed-in" },
    serverInfo: { voice: true },
  };
  const call = mock((_channel: string, method: string) => {
    if (method === "read") return read.promise;
    return Promise.resolve(answers[method]);
  });

  try {
    await withTestDom(async (host, root) => {
      Object.assign(window, { ipc: { call, listen: () => () => {} } });
      Object.defineProperty(document, "hasFocus", { value: () => true });
      // TipTap moves its editable DOM into the React host with Element.append.
      Object.defineProperty(Object.getPrototypeOf(host), "append", {
        configurable: true,
        value(this: HTMLElement, ...nodes: Node[]) {
          for (const node of nodes) this.appendChild(node);
        },
      });
      await act(async () => {
        root.render(<NoteTab workspaceId={workspaceId} tabId="tab" noteId={noteId} isVisible />);
      });
      expect(host.textContent).toContain("Opening the note");
      await act(async () => {
        await import("../../../../../src/renderer/components/notes/note-editor");
      });
      expect(call).toHaveBeenCalledWith("notes", "read", { workspaceId, noteId });
      try {
        await act(async () => read.resolve(note));
        expect(host.querySelector<HTMLInputElement>('[data-testid="note-title"]')?.value).toBe(
          note.title,
        );
        expect(host.querySelector('[data-testid="note-body"]')?.textContent).toBe("Note body");
      } finally {
        await act(async () => root.render(null));
        // TipTap defers destruction so its editor can survive React's dev remount.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  } finally {
    dropTranscript(workspaceId, noteId);
  }
});
