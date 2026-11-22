import i18next from "i18next";
import { NOTE_ID_RE } from "../../../shared/notes/types";

const MAX_SELECTION_LENGTH = 16_000;

export interface NoteReference {
  noteId: string;
  title: string;
}

function noteReferenceText(
  key: "mention" | "selectionQuote" | "read",
  { noteId, title }: NoteReference,
) {
  if (!NOTE_ID_RE.test(noteId)) throw new Error("Invalid note ID");
  const titleText = title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const values = {
    title: (titleText || i18next.t("notes:panel.untitled"))
      .replaceAll("‘", "‹")
      .replaceAll("’", "›")
      .replaceAll("`", "ˋ"),
    id: noteId,
  };
  return i18next
    .t(`notes:connections.${key}`, { skipInterpolation: true })
    .replace(/\{\{(title|id)\}\}/g, (_, name: keyof typeof values) => values[name]);
}

export function mentionLine(note: NoteReference): string {
  return noteReferenceText("mention", note);
}

export function withNoteMentions(message: string, notes: readonly NoteReference[]): string {
  if (!notes.length) return message;
  return [message.trimEnd(), notes.map(mentionLine).join("\n")].filter(Boolean).join("\n\n");
}

export function selectionPrompt(note: NoteReference, selection: string, message?: string): string {
  const normalized = selection.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/\p{Cf}/gu, "");
  let excerpt = normalized.slice(0, MAX_SELECTION_LENGTH);
  if (excerpt.length < normalized.length) {
    excerpt = `${excerpt.replace(/[\uD800-\uDBFF]$/u, "")}…`;
  }
  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    message?.trim() || i18next.t("notes:connections.selectionDefault"),
    `${noteReferenceText("selectionQuote", note)}\n${quote}`,
    noteReferenceText("read", note),
  ].join("\n\n");
}
