export function composerSendDecision(ready: boolean, shown: boolean, sameDraft: boolean) {
  if (!sameDraft) return "changed";
  return ready ? "send" : shown ? "wait" : "offline";
}

export interface PeerSendState {
  ready: boolean;
  until?: number;
}

export function waitForPeerSend(until: number, ready: () => boolean, sameDraft: () => boolean) {
  const { promise: result, resolve } = Promise.withResolvers<Exclude<
    ReturnType<typeof composerSendDecision>,
    "wait"
  > | null>();
  const finish = (decision: Awaited<typeof result>) => {
    clearTimeout(timer);
    resolve(decision);
  };
  const check = () => {
    const inTime = Date.now() < until;
    const decision = composerSendDecision(inTime && ready(), inTime, sameDraft());
    if (decision !== "wait") finish(decision);
  };
  const timer = setTimeout(
    () => finish(sameDraft() ? "offline" : "changed"),
    Math.max(0, until - Date.now()),
  );
  return { result, check, cancel: () => finish(null) };
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
