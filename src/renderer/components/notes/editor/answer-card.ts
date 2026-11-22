import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { hasAnswerCard } from "../../../../shared/notes/answer-card";
import { isEmptyDoc } from "../../../../shared/notes/insert";
import type { DocNode } from "../../../../shared/notes/markdown";

/** Matches main's append while preserving unflushed edits and the selection. */
export function applyAnswerCard(editor: Editor, card: DocNode): boolean {
  const linkId = card.attrs?.nexusLink;
  const { state, view } = editor;
  const doc = state.doc.toJSON() as DocNode;
  if (card.type !== "blockquote" || typeof linkId !== "string") return false;
  if (hasAnswerCard(doc, linkId)) return true;
  const tr = state.tr
    .replaceWith(
      isEmptyDoc(doc) ? 0 : state.doc.content.size,
      state.doc.content.size,
      state.schema.nodeFromJSON(card),
    )
    .setMeta("preventAutolink", true)
    .setMeta("addToHistory", false);
  view.dispatch(tr);
  return hasAnswerCard(editor.state.doc.toJSON() as DocNode, linkId);
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

interface AnswerWidgetState {
  widgets: DecorationSet;
  liveLinks: ReadonlySet<string>;
}

const key = new PluginKey<AnswerWidgetState>("noteAnswerCards");

export function setLiveCardLinks(editor: Editor, liveLinks: ReadonlySet<string>) {
  if (editor.isDestroyed) return;
  const current = key.getState(editor.state);
  if (
    !current ||
    (current.liveLinks.size === liveLinks.size &&
      [...liveLinks].every((id) => current.liveLinks.has(id)))
  )
    return;
  editor.view.dispatch(editor.state.tr.setMeta(key, liveLinks).setMeta("addToHistory", false));
}

function inLiveTitle(pos: ResolvedPos, liveLinks: ReadonlySet<string>): boolean {
  if (pos.depth < 2 || pos.parent.type.name !== "paragraph" || pos.index(-1) !== 0) return false;
  const quote = pos.node(-1);
  return quote.type.name === "blockquote" && liveLinks.has(quote.attrs.nexusLink);
}

/** Skip the hidden title of each live card crossed by the caret. */
function selectionOutsideLiveTitle(
  selection: Selection,
  liveLinks: ReadonlySet<string>,
  direction: -1 | 1,
): Selection | null {
  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    !inLiveTitle(selection.$head, liveLinks)
  )
    return null;
  const doc = selection.$head.doc;
  const cardPos = selection.$head.before(-1);
  let candidate: Selection | null = selection;
  while (candidate && inLiveTitle(candidate.$head, liveLinks)) {
    const boundary = direction === 1 ? candidate.$head.after() : candidate.$head.before(-1);
    candidate = Selection.findFrom(doc.resolve(boundary), direction, true);
  }
  return candidate ?? NodeSelection.create(doc, cardPos);
}

export const NoteAnswerWidgets = Extension.create({
  name: "noteAnswerWidgets",
  addProseMirrorPlugins: () => [
    new Plugin<AnswerWidgetState>({
      key,
      state: {
        init: (_, state) => ({ widgets: decorations(state.doc), liveLinks: new Set() }),
        apply: (tr, previous) => {
          const liveLinks = tr.getMeta(key) as ReadonlySet<string> | undefined;
          if (!tr.docChanged && !liveLinks) return previous;
          return {
            widgets: tr.docChanged ? decorations(tr.doc) : previous.widgets,
            liveLinks: liveLinks ?? previous.liveLinks,
          };
        },
      },
      props: { decorations: (state) => key.getState(state)?.widgets },
      appendTransaction: (_transactions, before, after) => {
        const links = key.getState(after)?.liveLinks;
        if (!links?.size) return;
        const direction = after.selection.head < before.selection.head ? -1 : 1;
        const selection = selectionOutsideLiveTitle(after.selection, links, direction);
        if (selection) return after.tr.setSelection(selection).setMeta("addToHistory", false);
      },
    }),
  ],
});
