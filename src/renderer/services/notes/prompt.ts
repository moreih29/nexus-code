import i18next from "i18next";
import { noteLabel } from "../../../shared/notes/line-report";
import { escapeText } from "../../../shared/notes/markdown";
import { NOTE_ID_RE } from "../../../shared/notes/types";

export interface NoteReference {
  noteId: string;
  title: string;
}

function referenceValues({ noteId, title }: NoteReference) {
  if (!NOTE_ID_RE.test(noteId)) throw new Error("Invalid note ID");
  const label = noteLabel(title, i18next.t("notes:panel.untitled")).slice(1, -1);
  return {
    title: label.replace(
      /['‘’“”`*_[\]]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
    id: noteId,
    interpolation: { escapeValue: false, skipOnVariables: true },
  };
}

export function mentionLine(note: NoteReference): string {
  return i18next.t("notes:connections.mention", referenceValues(note));
}

export function withNoteMentions(message: string, notes: readonly NoteReference[]): string {
  if (!notes.length) return message;
  return [message.trimEnd(), notes.map(mentionLine).join("\n")].filter(Boolean).join("\n\n");
}

export function selectionPrompt(note: NoteReference, selection: string, message?: string): string {
  const values = referenceValues(note);
  const quote = selection
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${escapeText(line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "))}`)
    .join("\n");
  return [
    message?.trim() || i18next.t("notes:connections.selectionDefault"),
    `${i18next.t("notes:connections.selectionQuote", values)}\n${quote}`,
    i18next.t("notes:connections.read", values),
  ].join("\n\n");
}
