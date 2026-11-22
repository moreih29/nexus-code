import { expect, test } from "bun:test";
import {
  createNoteDocumentInbox,
  type NoteDocumentEvent,
} from "../../../../../src/renderer/services/notes/document-inbox";
import type { NoteLineReported } from "../../../../../src/shared/types/notes";

test("line reports wait for the editor and only reach the same note and location", () => {
  const inbox = createNoteDocumentInbox<NoteDocumentEvent>("local:/repo", "n1234567");
  const report: NoteLineReported = {
    locationKey: "local:/repo",
    noteId: "n1234567",
    linkId: "l1234567",
    updatedAt: 10,
    check: true,
    result: { state: "done", summary: "Done", at: 1 },
  };
  const seen: number[] = [];
  inbox.receive({ ...report, locationKey: "local:/other" });
  inbox.receive({ ...report, noteId: "n7654321" });
  inbox.receive(report);
  inbox.receive({
    locationKey: report.locationKey,
    noteId: report.noteId,
    updatedAt: 11,
    blocks: [],
  });
  expect(seen).toEqual([]);
  const detach = inbox.attach(({ updatedAt }) => seen.push(updatedAt));
  expect(seen).toEqual([10, 11]);
  inbox.receive({ ...report, updatedAt: 12 });
  inbox.receive({ ...report, locationKey: "local:/other", updatedAt: 13 });
  expect(seen).toEqual([10, 11, 12]);
  detach();
  inbox.receive({ ...report, updatedAt: 14 });
  expect(seen).toEqual([10, 11, 12]);
  const detachAgain = inbox.attach(({ updatedAt }) => seen.push(updatedAt));
  expect(seen).toEqual([10, 11, 12, 14]);
  detachAgain();
});
