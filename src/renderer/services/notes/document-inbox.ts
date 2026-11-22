import type { NoteBlocksAdded, NoteLineReported } from "../../../shared/types/notes";

export type NoteDocumentEvent = NoteLineReported | (NoteBlocksAdded & { updatedAt: number });

export function createNoteDocumentRevision(initial: number) {
  let updatedAt = initial;
  let missedChange = false;
  return {
    get updatedAt() {
      return updatedAt;
    },
    apply(revision: number, applyToEditor: () => boolean) {
      if (revision <= updatedAt) return;
      try {
        if (applyToEditor()) {
          if (!missedChange) updatedAt = revision;
          return;
        }
      } catch {
        // The disk copy still has the change if the editor rejects the transaction.
      }
      // Later changes cannot acknowledge the missed one. Keep disk-side merging enabled.
      missedChange = true;
    },
  };
}

/** Holds document changes that arrive before the note's editor is ready. */
export function createNoteDocumentInbox<T extends NoteDocumentEvent>(
  locationKey: string | undefined,
  noteId: string,
) {
  const pending: T[] = [];
  let handler: ((event: T) => void) | undefined;
  return {
    receive(event: T) {
      if (event.locationKey !== locationKey || event.noteId !== noteId) return;
      if (handler) handler(event);
      else pending.push(event);
    },
    attach(apply: (event: T) => void) {
      handler = apply;
      for (const event of pending.splice(0)) apply(event);
      return () => {
        if (handler === apply) handler = undefined;
      };
    },
  };
}
