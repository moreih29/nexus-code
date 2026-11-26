export function composerSendDecision(ready: boolean, shown: boolean, sameDraft: boolean) {
  if (!sameDraft) return "changed";
  return ready ? "send" : shown ? "wait" : "offline";
}

export function canRestoreFailedDraft(
  draft: {
    text: string;
    images: readonly unknown[];
    files: readonly unknown[];
    notes?: readonly unknown[];
  },
  status: "failed" | "unconfirmed",
): boolean {
  return (
    status === "failed" &&
    draft.text === "" &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    !draft.notes?.length
  );
}
