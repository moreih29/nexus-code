import type { ExpectedFileStateContract, WriteFileResult } from "../../../../shared/fs/types";

/** Confirm a collision in the target workspace before retrying against that exact file state. */
export async function writeConfirmedSaveTarget(
  write: (expected: ExpectedFileStateContract) => Promise<WriteFileResult>,
  confirmReplacement: () => Promise<boolean>,
): Promise<WriteFileResult | null> {
  const first = await write({ exists: false });
  if (first.kind !== "conflict" || !first.actual.exists) return first;
  if (!(await confirmReplacement())) return null;
  return write(first.actual);
}
