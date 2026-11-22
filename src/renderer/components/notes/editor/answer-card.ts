import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { hasAnswerCard } from "../../../../shared/notes/answer-card";
import { isEmptyDoc } from "../../../../shared/notes/insert";
import type { DocNode } from "../../../../shared/notes/markdown";

/** Matches main's append while preserving unflushed edits and the selection. */
export function applyAnswerCard(editor: Editor, card: DocNode): void {
  const linkId = card.attrs?.nexusLink;
  const { state, view } = editor;
  const doc = state.doc.toJSON() as DocNode;
  if (card.type !== "blockquote" || typeof linkId !== "string" || hasAnswerCard(doc, linkId))
    return;
  const tr = state.tr
    .replaceWith(
      isEmptyDoc(doc) ? 0 : state.doc.content.size,
      state.doc.content.size,
      state.schema.nodeFromJSON(card),
    )
    .setMeta("preventAutolink", true);
  view.dispatch(tr);
}

function decorations(doc: ProseMirrorNode): DecorationSet {
  const widgets: Decoration[] = [];
  doc.descendants((node, pos) => {
    const linkId = node.attrs.nexusLink;
    if (node.type.name !== "blockquote" || typeof linkId !== "string") return;
    widgets.push(
      Decoration.widget(
        pos + 1,
        () => {
          const dom = document.createElement("div");
          dom.dataset.noteAnswerCard = linkId;
          return dom;
        },
        { key: linkId, side: -1, stopEvent: () => true, ignoreSelection: true },
      ),
    );
  });
  return DecorationSet.create(doc, widgets);
}

const key = new PluginKey<DecorationSet>("noteAnswerCards");

export const NoteAnswerWidgets = Extension.create({
  name: "noteAnswerWidgets",
  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (_, state) => decorations(state.doc),
        apply: (tr, previous) => (tr.docChanged ? decorations(tr.doc) : previous),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
});
