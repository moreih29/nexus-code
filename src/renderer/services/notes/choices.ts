import type { NoteSummary } from "../../../shared/notes/types";
import type { NoteReference } from "./prompt";

export type NoteChoice = NoteReference & { linked: boolean };

export function noteChoices(
  linked: readonly NoteReference[],
  workspace: readonly Pick<NoteSummary, "id" | "title" | "updatedAt">[],
  query = "",
  untitled = "",
): NoteChoice[] {
  const ids = new Set(linked.map(({ noteId }) => noteId));
  const term = query.trim().normalize().toLowerCase();
  const matches = (title: string) => (title || untitled).normalize().toLowerCase().includes(term);
  const recent = workspace
    .filter(({ id, title }) => !ids.has(id) && matches(title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);
  return [
    ...linked.filter(({ title }) => matches(title)).map((note) => ({ ...note, linked: true })),
    ...recent.map(({ id, title }) => ({ noteId: id, title, linked: false })),
  ];
}
