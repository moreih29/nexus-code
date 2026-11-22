import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const key = new PluginKey<DecorationSet>("noteSummaryDivider");

function dividers(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.forEach((node, pos) => {
    const origin = node.attrs.nexusOrigin;
    if (
      node.type.name === "paragraph" &&
      typeof origin === "string" &&
      origin.startsWith("summary:")
    ) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "note-summary-divider" }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const NoteSummaryDivider = Extension.create({
  name: "noteSummaryDivider",
  addProseMirrorPlugins: () => [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => dividers(state.doc),
        apply: (tr, previous) => (tr.docChanged ? dividers(tr.doc) : previous),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
});
