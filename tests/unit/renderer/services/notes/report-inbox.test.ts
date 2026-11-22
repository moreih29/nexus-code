import { expect, test } from "bun:test";
import { createLineReportInbox } from "../../../../../src/renderer/services/notes/report-inbox";
import type { NoteLineReported } from "../../../../../src/shared/types/notes";

test("line reports wait for the editor and only reach the same note and location", () => {
  const inbox = createLineReportInbox("local:/repo", "n1234567");
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
  inbox.receive({ ...report, updatedAt: 11 });
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
