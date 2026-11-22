import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  isReportParagraph,
  type LineReport,
  reportParagraph,
} from "../../../../shared/notes/line-report";

/** Applies the same report as main, leaving the editor's other edits and selection in place. */
export function applyLineReport(editor: Editor, report: LineReport): boolean {
  const { state, view } = editor;
  let task: { node: ProseMirrorNode; pos: number } | undefined;
  let ambiguous = false;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem" || node.attrs.nexusLink !== report.linkId) return;
    if (task) ambiguous = true;
    else task = { node, pos };
  });
  if (!task || ambiguous) return false;
  const { node, pos } = task;
  const paragraph = state.schema.nodeFromJSON(reportParagraph(report));
  const tr = state.tr;
  if (report.check && !node.attrs.checked)
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: true });
  let existing: { pos: number; node: ProseMirrorNode } | undefined;
  node.forEach((child, offset) => {
    if (
      !existing &&
      isReportParagraph({ type: child.type.name, attrs: child.attrs }, report.linkId)
    ) {
      existing = { pos: pos + 1 + offset, node: child };
    }
  });
  if (existing) {
    if (!existing.node.eq(paragraph)) {
      tr.replaceWith(existing.pos, existing.pos + existing.node.nodeSize, paragraph);
    }
  } else if (node.firstChild) {
    tr.insert(pos + 1 + node.firstChild.nodeSize, paragraph);
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}
