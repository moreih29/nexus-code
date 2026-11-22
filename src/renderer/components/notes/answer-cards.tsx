import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ConversationChip, useNoteConversations } from "./conversation-chips";
import { setLiveCardLinks } from "./editor/answer-card";

export function NoteAnswerCards({ editor }: { editor: Editor }) {
  const rows = useNoteConversations();
  const [widgets, setWidgets] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    setLiveCardLinks(
      editor,
      new Set(rows.filter(({ entry }) => entry.link.kind === "live").map(({ entry }) => entry.id)),
    );
  }, [editor, rows]);
  useLayoutEffect(() => {
    const sync = () => {
      if (editor.isDestroyed) return;
      const next = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>("[data-note-answer-card]"),
      );
      setWidgets((old) =>
        old.length === next.length && old.every((widget, i) => widget === next[i]) ? old : next,
      );
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);
  const cards = new Map(
    rows
      .filter(({ entry }) => entry.link.kind === "card" || entry.link.kind === "live")
      .map((row) => [row.entry.id, row]),
  );
  return widgets.map((widget) => {
    const id = widget.dataset.noteAnswerCard;
    const row = id && cards.get(id);
    return row ? createPortal(<ConversationChip {...row} card />, widget, id) : null;
  });
}
