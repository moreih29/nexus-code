import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { draftImagesOf, peerRewinder } = await import(
  "../../../../../src/renderer/components/agent-view/remote-chat-actions"
);
const { peerDraftOf } = await import("../../../../../src/renderer/services/remote/peer-drafts");

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
const globals = globalThis as Record<string, unknown>;
let saved: unknown;

const chat = { deviceId: "d1", workspaceId: "w1", tabId: "t1" };
const ref = (index: number) => ({ kind: "user" as const, itemKey: "u1", index });

beforeEach(() => {
  calls.length = 0;
  saved = globals.window;
  globals.window = {
    ...((saved as object | undefined) ?? {}),
    ipc: {
      call: async (_channel: string, method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        if (method === "peerChatImage") {
          const { index } = args.ref as { index: number };
          return index === 1
            ? { __nexusIpcResult_a3f8b1d2: true, ok: false, kind: "unavailable", message: "gone" }
            : { mediaType: "image/png", data: `png${index}` };
        }
        return {};
      },
      cancel: () => {},
    },
  };
});

afterEach(() => {
  globals.window = saved;
});

describe("a message's images in the draft a rewind or fork leaves here", () => {
  test("are read from that computer whole; one it cannot send is left out", async () => {
    const images = await draftImagesOf(chat, [
      { mediaType: "image/png", data: "", remote: ref(0) },
      { mediaType: "image/png", data: "", remote: ref(1) },
      { mediaType: "image/jpeg", data: "here" },
    ]);
    expect(images).toEqual([
      { mediaType: "image/png", data: "png0" },
      { mediaType: "image/jpeg", data: "here" },
    ]);
    // As large as it sends one: no thumbnail's edge.
    expect(calls[0]?.args).toEqual({ ...chat, ref: ref(0) });
  });

  test("a rewind reads them before it goes, and puts them in with the text", async () => {
    await peerRewinder(chat).rewind(
      {
        kind: "user",
        key: "u1",
        uuid: "u1",
        text: "look at this",
        images: [{ mediaType: "image/png", data: "", remote: ref(0) }],
        state: "taken",
      } as never,
      { files: false },
    );
    expect(calls.map((c) => c.method)).toEqual(["peerChatImage", "peerChatRewind"]);
    expect(peerDraftOf(chat)).toMatchObject({
      text: "look at this",
      images: [{ mediaType: "image/png", data: "png0" }],
    });
  });
});
