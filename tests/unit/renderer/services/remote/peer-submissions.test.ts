import { afterEach, describe, expect, test } from "bun:test";
import { peerComposerController } from "../../../../../src/renderer/services/remote/peer-composer";
import {
  clearPeerComposition,
  peerContentsOf,
  restorePeerComposition,
} from "../../../../../src/renderer/services/remote/peer-drafts";
import {
  beginPeerSubmission,
  forgetPeerSubmissions,
  observePeerEchoes,
  peerSubmissionsOf,
  previewOf,
  recoverPeerSubmission,
  settlePeerSubmission,
} from "../../../../../src/renderer/services/remote/peer-submissions";

const ref = { deviceId: "host", workspaceId: "work", tabId: "first" };
const other = { ...ref, tabId: "second" };
const own = "my-desktop";
const files = [{ id: 1, file: new File(["notes"], "notes.txt") }];
const input = { text: "repeat", images: [], files: [], baseline: 10 };

function echo(key: string, clientNonce?: string, clientDeviceId?: string, index = 10) {
  return {
    index,
    item: {
      kind: "user" as const,
      state: "taken" as const,
      key,
      text: "repeat",
      images: [],
      clientNonce,
      clientDeviceId,
    },
  };
}

afterEach(() => {
  forgetPeerSubmissions(ref);
  forgetPeerSubmissions(other);
  clearPeerComposition(ref, peerContentsOf(ref));
  clearPeerComposition(other, peerContentsOf(other));
});

describe("optimistic remote submissions", () => {
  test("publishes a bubble synchronously before sending file bytes, then reconciles watch before ACK", async () => {
    let completeFile!: (value: unknown) => void;
    let ack!: (value: unknown) => void;
    const sent: Record<string, unknown>[] = [];
    const call = (async (_channel: string, method: string, args: Record<string, unknown>) => {
      if (method === "peerChatUploadBegin") return { ok: true, value: { uploadId: "file-id" } };
      if (method === "peerChatUploadChunk") return { ok: true, value: {} };
      if (method === "peerChatUploadEnd")
        return new Promise((resolve) => {
          completeFile = resolve;
        });
      if (method === "peerChatSend") {
        sent.push(args);
        return new Promise((resolve) => {
          ack = resolve;
        });
      }
      throw new Error(method);
    }) as never;
    const controller = peerComposerController({
      ref,
      agent: "codex",
      settings: () => null,
      onSettings: () => {},
      filesRefused: "unavailable",
      can: () => ({ rewind: false, fork: false, background: false, clientNonce: true }),
      submissionContext: () => ({ selfId: own, baseline: 10 }),
      call,
    });
    expect(controller.submitPeer?.("send", "repeat", [], files)).toBe(true);
    const entry = peerSubmissionsOf(ref)[0]!;
    expect(previewOf(entry)).toMatchObject({
      text: "repeat",
      optimistic: { status: "sending", fileNames: ["notes.txt"] },
    });
    expect(sent).toHaveLength(0);
    await Bun.sleep(0);
    completeFile({ ok: true, value: { attachmentId: "file-id" } });
    await Bun.sleep(0);
    expect(sent).toEqual([
      { ...ref, text: "repeat", clientNonce: entry.nonce, attachments: ["file-id"] },
    ]);
    observePeerEchoes(ref, [echo("host-row", entry.nonce, own)]);
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
    ack({ ok: true, value: { clientNonce: entry.nonce, itemKey: "host-row" } });
    await Bun.sleep(0);
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
  });

  test("matches device and nonce independently of identical text, order, tab or response loss", () => {
    const first = beginPeerSubmission(ref, { ...input, clientDeviceId: own });
    const second = beginPeerSubmission(ref, { ...input, clientDeviceId: own });
    const elsewhere = beginPeerSubmission(other, { ...input, clientDeviceId: own });
    observePeerEchoes(ref, [echo("another-user", first.nonce, "another-device")]);
    expect(peerSubmissionsOf(ref)).toHaveLength(2);
    settlePeerSubmission(ref, first, { status: "unconfirmed", error: "connection dropped" });
    observePeerEchoes(ref, [
      echo("second", second.nonce, own),
      echo("other-tab", elsewhere.nonce, own),
    ]);
    expect(peerSubmissionsOf(ref).map((entry) => entry.nonce)).toEqual([first.nonce]);
    observePeerEchoes(ref, [echo("first-after-reconnect", first.nonce, own)]);
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
    expect(peerSubmissionsOf(other)).toEqual([elsewhere]);
  });

  test("a held message is confirmed by watch before or after its receipt", () => {
    const pending = beginPeerSubmission(ref, { ...input, timing: "after", clientDeviceId: own });
    settlePeerSubmission(ref, pending, { status: "accepted", heldId: "q1" });
    expect(previewOf(peerSubmissionsOf(ref)[0]!).optimistic).toMatchObject({
      queued: true,
      status: "accepted",
    });
    observePeerEchoes(
      ref,
      [],
      [{ id: "q1", text: "repeat", clientNonce: pending.nonce, clientDeviceId: own }],
    );
    observePeerEchoes(ref, [echo("taken", pending.nonce, own)], []);
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
    const legacy = beginPeerSubmission(ref, { ...input, timing: "after" });
    observePeerEchoes(ref, [], [{ id: "q2", text: "repeat" }]);
    expect(peerSubmissionsOf(ref)).toEqual([legacy]);
    settlePeerSubmission(ref, legacy, { status: "accepted", heldId: "q2" });
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
  });

  test("a legacy same-text watch row cannot consume the recovery draft before ACK", () => {
    observePeerEchoes(ref, [echo("older", undefined, undefined, 9)]);
    const pending = beginPeerSubmission(ref, { ...input, files });
    observePeerEchoes(ref, [
      echo("older", undefined, undefined, 10),
      { index: 11, item: { ...echo("ambiguous").item, text: "repeat\n\n@notes.txt" } },
    ]);
    expect(peerSubmissionsOf(ref)[0]?.provisionalEcho).toBe("ambiguous");
    expect(peerSubmissionsOf(ref)).toHaveLength(1);
    settlePeerSubmission(ref, pending, { status: "unconfirmed", error: "timed out" });
    expect(peerSubmissionsOf(ref)[0]).toMatchObject({ status: "unconfirmed" });
    expect(recoverPeerSubmission(ref, pending.nonce)?.files).toEqual(files);
  });

  test("a lost answer with no row seen keeps the draft to recover", () => {
    observePeerEchoes(ref, [echo("older", undefined, undefined, 9)]);
    const pending = beginPeerSubmission(ref, { ...input, files });
    settlePeerSubmission(ref, pending, { status: "unconfirmed", error: "timed out" });
    expect(peerSubmissionsOf(ref)[0]?.status).toBe("unconfirmed");
    const recovered = recoverPeerSubmission(ref, pending.nonce);
    expect(recovered?.files).toEqual(files);
    restorePeerComposition(ref, recovered!);
    expect(peerContentsOf(ref)).toMatchObject({ text: "repeat", files });
    expect(peerSubmissionsOf(ref)).toHaveLength(0);
  });

  test("a refusal keeps its draft even where a same-text row was seen", () => {
    observePeerEchoes(ref, [echo("older", undefined, undefined, 9)]);
    const pending = beginPeerSubmission(ref, input);
    observePeerEchoes(ref, [echo("other", undefined, undefined, 11)]);
    expect(peerSubmissionsOf(ref)[0]?.provisionalEcho).toBe("other");
    settlePeerSubmission(ref, pending, { status: "failed", error: "refused" });
    expect(peerSubmissionsOf(ref)[0]).toMatchObject({ status: "failed", error: "refused" });
  });

  test.each([
    ["unchanged draft", false, ""],
    ["new text", true, "repeat\nnext"],
  ] as const)("clears only the submitted draft with %s", (_name, changed, expected) => {
    restorePeerComposition(ref, input);
    const submitted = peerContentsOf(ref);
    if (changed) restorePeerComposition(ref, { ...input, text: "next" });
    clearPeerComposition(ref, submitted);
    expect(peerContentsOf(ref).text).toBe(expected);
  });

  test.each([
    ["send-rejected", "", "repeat", undefined],
    ["send-rejected", "next", "next", "failed"],
    ["send-unconfirmed", "", "", "unconfirmed"],
  ] as const)("settles %s with %j in the composer", async (kind, latest, expected, status) => {
    const result = Promise.withResolvers<{ ok: false; kind: string; message: string }>();
    const controller = peerComposerController({
      ref,
      agent: "codex",
      settings: () => null,
      onSettings: () => {},
      filesRefused: "unavailable",
      call: (() => result.promise) as never,
    });
    expect(controller.submitPeer?.("send", "repeat", [], [])).toBe(true);
    if (latest) restorePeerComposition(ref, { ...input, text: latest });
    result.resolve({ ok: false, kind, message: "send did not confirm" });
    await Bun.sleep(0);
    expect(peerContentsOf(ref).text).toBe(expected);
    expect(peerSubmissionsOf(ref)[0]?.status).toBe(status);
  });
});
