import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cancelTabFocus } from "../../../../../src/renderer/services/tab-focus";
import { __resetAgentViewForTests } from "../../../../../src/renderer/state/stores/agent-view";
import {
  type RemoteTarget,
  useRemoteViewStore,
} from "../../../../../src/renderer/state/stores/remote-view";

const { draftImagesOf, forkPeerChat, peerRewinder } = await import(
  "../../../../../src/renderer/components/agent-view/remote-chat-actions"
);
const { applyPeerDraft, peerContentsOf, peerDraftOf } = await import(
  "../../../../../src/renderer/services/remote/peer-drafts"
);

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
const globals = globalThis as Record<string, unknown>;
let saved: unknown;

const chat = { deviceId: "d1", workspaceId: "w1", tabId: "t1" };
const ref = (index: number) => ({ kind: "user" as const, itemKey: "u1", index });

function resetPanels() {
  __resetAgentViewForTests();
  useRemoteViewStore.setState({ targets: new Map() });
  cancelTabFocus();
}

beforeEach(() => {
  resetPanels();
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
        if (method === "peerChatFork") return { tabId: "copy" };
        return {};
      },
      cancel: () => {},
    },
  };
});

afterEach(() => {
  resetPanels();
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

test("a fork preserves the selected prompt on the child when the reply omits the draft", async () => {
  await forkPeerChat({ ...chat, kind: "codex", path: "/p", state: "idle" } as RemoteTarget, "u1", {
    text: "try again",
    images: [{ mediaType: "image/png", data: "", remote: ref(0) }],
  });
  const child = { ...chat, tabId: "copy" };
  expect(calls.map((c) => c.method)).toEqual(["peerChatFork", "peerChatImage"]);
  expect(peerDraftOf(child)).toMatchObject({ text: "try again" });
  applyPeerDraft(child);
  applyPeerDraft(child);
  expect(peerDraftOf(child)).toBeUndefined();
  expect(peerContentsOf(child)).toEqual({
    text: "try again",
    images: [{ mediaType: "image/png", data: "png0" }],
    files: [],
  });
  expect(peerContentsOf(chat).text).toBe("");
});
