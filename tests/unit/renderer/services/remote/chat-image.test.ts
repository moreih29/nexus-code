/** An image of a chat for another device: found by its ref, sent as it is when it fits, else drawn smaller. */
import { describe, expect, test } from "bun:test";
import type { ChatItem, ToolCall } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  fitImage,
  imageOf,
  type Shrink,
} from "../../../../../src/renderer/services/remote/chat-image";
import type { ChatSource } from "../../../../../src/renderer/services/remote/chat-page";

const pic = (data: string, mediaType = "image/png") => ({ mediaType, data });

function source(): ChatSource {
  const user: ChatItem = {
    kind: "user",
    key: "k1",
    uuid: "u1",
    text: "look",
    images: [pic("AAAA"), pic("BBBB")],
    state: "taken",
  };
  const tool: ToolCall = {
    id: "tu1",
    name: "Read",
    input: {},
    status: "done",
    parentToolUseId: null,
    result: { text: "", isError: false, images: [pic("CCCC")] },
  };
  return {
    agent: "claude",
    title: "Chat",
    chat: {
      ...emptyTabState(),
      model: { ...emptyModel(), items: [user], tools: { tu1: tool } },
    },
  };
}

describe("an image of a chat", () => {
  test("is a user message's by its key and index, or a tool result's by its call", () => {
    expect(imageOf(source(), { kind: "user", itemKey: "k1", index: 1 })?.data).toBe("BBBB");
    expect(imageOf(source(), { kind: "tool", toolUseId: "tu1", index: 0 })?.data).toBe("CCCC");
    expect(imageOf(source(), { kind: "user", itemKey: "k1", index: 2 })).toBeNull();
    expect(imageOf(source(), { kind: "tool", toolUseId: "nope", index: 0 })).toBeNull();
  });

  test("goes as it is when it fits and is of a type the other device takes", async () => {
    const never: Shrink = async () => {
      throw new Error("drawn");
    };
    expect(await fitImage(pic("AAAA"), 10, never)).toEqual({
      mediaType: "image/png",
      data: "AAAA",
    });
  });

  test("is drawn smaller till it fits, or given up on", async () => {
    const scales: number[] = [];
    // Each draw comes out a little over what its scale predicts, at first.
    const shrink: Shrink = async (image, scale) => {
      scales.push(scale);
      const chars = Math.round(image.data.length * scale * scale * (scales.length === 1 ? 2 : 1));
      return { mediaType: "image/jpeg", data: "x".repeat(chars), width: 10, height: 10 };
    };
    const fitted = await fitImage(pic("x".repeat(1000)), 400, shrink);
    expect(fitted.data.length).toBeLessThanOrEqual(400);
    expect(scales).toHaveLength(2);
    expect(scales[1]).toBeLessThan(scales[0]);
    const stubborn: Shrink = async () => ({
      mediaType: "image/jpeg",
      data: "x".repeat(500),
      width: 1,
      height: 1,
    });
    await expect(fitImage(pic("x".repeat(1000)), 400, stubborn)).rejects.toThrow("small enough");
  });

  test("of a type the other device does not take is drawn again, though small", async () => {
    let drawn = false;
    const shrink: Shrink = async () => {
      drawn = true;
      return { mediaType: "image/jpeg", data: "jpg", width: 1, height: 1 };
    };
    expect((await fitImage(pic("AA", "image/bmp"), 100, shrink)).mediaType).toBe("image/jpeg");
    expect(drawn).toBe(true);
  });
});
