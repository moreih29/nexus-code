import type { NoteLineReported } from "../../../shared/types/notes";

type ReceiveReport = (event: NoteLineReported) => void;

/** Holds reports that arrive after a note starts opening and before its editor is ready. */
export function createLineReportInbox(locationKey: string | undefined, noteId: string) {
  const pending: NoteLineReported[] = [];
  let handler: ReceiveReport | undefined;
  return {
    receive(event: NoteLineReported) {
      if (event.locationKey !== locationKey || event.noteId !== noteId) return;
      if (handler) handler(event);
      else pending.push(event);
    },
    attach(apply: ReceiveReport) {
      handler = apply;
      for (const event of pending.splice(0)) apply(event);
      return () => {
        if (handler === apply) handler = undefined;
      };
    },
  };
}
