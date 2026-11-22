import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { taskSource } from "../../../../shared/notes/line-report";

export interface TaskWidget {
  dom: HTMLElement;
  linkId?: string;
  origin?: string;
  speaker: string;
  at?: number;
  taskPos(): number | undefined;
}

const widgets = new WeakMap<Element, TaskWidget>();
const key = new PluginKey<DecorationSet>("noteTasks");
const selector = "[data-note-task-widget]";
let widgetId = 0;

export function taskWidgets(view: EditorView): TaskWidget[] {
  return Array.from(view.dom.querySelectorAll(selector)).flatMap((dom) => {
    const widget = widgets.get(dom);
    return widget ? [widget] : [];
  });
}

function decorations(doc: ProseMirrorNode, previous = DecorationSet.empty): DecorationSet {
  const result: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (
      node.type.name === "paragraph" &&
      typeof node.attrs.nexusOrigin === "string" &&
      node.attrs.nexusOrigin.startsWith("report:")
    ) {
      result.push(Decoration.node(pos, pos + node.nodeSize, { class: "note-task-report" }));
    }
    if (node.type.name !== "taskItem" || node.firstChild?.type.name !== "paragraph") return;
    const { nexusLink } = node.attrs;
    let { nexusOrigin } = node.attrs;
    if (!nexusOrigin && node.attrs.nexusAt !== null) {
      const $pos = doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth--) {
        const origin = $pos.node(depth).attrs.nexusOrigin;
        if (typeof origin === "string" && origin.startsWith("summary:")) {
          nexusOrigin = origin;
          break;
        }
      }
    }
    const linkId = typeof nexusLink === "string" ? nexusLink : undefined;
    const origin = typeof nexusOrigin === "string" ? nexusOrigin : undefined;
    const source = taskSource(node.attrs);
    if (
      !linkId &&
      !source.speaker &&
      source.at === undefined &&
      !node.firstChild.textContent.trim()
    )
      return;
    const end = pos + node.firstChild.nodeSize;
    const attrs = JSON.stringify([linkId, origin, source.speaker, source.at]);
    const old = previous.find(end, end, (spec) => spec.attrs === attrs)[0];
    if (old) {
      result.push(old);
      return;
    }
    result.push(
      Decoration.widget(
        end,
        (view, getPos) => {
          const dom = document.createElement("span");
          dom.dataset.noteTaskWidget = String(++widgetId);
          widgets.set(dom, {
            dom,
            linkId,
            origin,
            ...source,
            taskPos: () => {
              const at = getPos();
              if (at === undefined) return;
              const $at = view.state.doc.resolve(at);
              if ($at.depth >= 2 && $at.node(-1).type.name === "taskItem") return $at.before(-1);
            },
          });
          return dom;
        },
        { attrs, side: 1, stopEvent: () => true, ignoreSelection: true },
      ),
    );
  });
  return DecorationSet.create(doc, result);
}

export const NoteTaskWidgets = Extension.create({
  name: "noteTaskWidgets",
  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (_, state) => decorations(state.doc),
        apply: (tr, previous) =>
          tr.docChanged ? decorations(tr.doc, previous.map(tr.mapping, tr.doc)) : previous,
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
  ],
});
