// Write to a path picked in the native save dialog.
//
// The dialog itself asks before the user picks an existing file, so by the
// time a path comes back the user has already agreed to replace it. The
// stale-write guard still applies: the first write expects no file, and when
// one exists the write is retried against the state the conflict reported.
// A second conflict means the file changed again in between.

import type { ExpectedFileStateContract, WriteFileResult } from "../../../../shared/fs/types";

export async function writeConfirmedSaveTarget(
  write: (expected: ExpectedFileStateContract) => Promise<WriteFileResult>,
): Promise<WriteFileResult> {
  const first = await write({ exists: false });
  if (first.kind !== "conflict") return first;
  return write(first.actual);
}
