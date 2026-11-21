/** An image of a chat for another device: found by its ref, sent as it is when it fits, else drawn smaller. */
import { describe, expect, test } from "bun:test";
import type { ChatItem, ToolCall } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  fitImage,
  imageOf,
  readChatImage,
  type Shrink,
} from "../../../../../src/renderer/services/remote/chat-image";
import type { ChatSource } from "../../../../../src/renderer/services/remote/chat-page";

const pic = (data: string, mediaType = "image/png") => ({ mediaType, data });

/** A PNG's base64 whose header says `width` by `height`, padded to about `chars`. */
function pngData(width: number, height: number, chars = 40): string {
  const b = Buffer.alloc(Math.max(24, Math.ceil((chars * 3) / 4)), 1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString("base64");
}

/** A BMP's base64 whose header says `width` by `height`. */
function bmpData(width: number, height: number): string {
  const b = Buffer.alloc(54);
  b.write("BM", 0, "ascii");
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(-height, 22);
  return b.toString("base64");
}

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
      queue: [{ id: "q1", text: "later", images: [pic("DDDD")] }],
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

  test("is a held message's by its id and index, none once it went", () => {
    expect(imageOf(source(), { kind: "held", id: "q1", index: 0 })?.data).toBe("DDDD");
    expect(imageOf(source(), { kind: "held", id: "q1", index: 1 })).toBeNull();
    expect(imageOf(source(), { kind: "held", id: "q2", index: 0 })).toBeNull();
  });

  test("goes as it is when it fits and is of a type the other device takes", async () => {
    const never: Shrink = async () => {
      throw new Error("drawn");
    };
    const data = pngData(2, 2);
    expect(await fitImage(pic(data), { maxChars: 100 }, never)).toEqual({
      mediaType: "image/png",
      data,
      width: 2,
      height: 2,
    });
  });

  test("versioned reads prove only the requested source and representation", async () => {
    const image = pic(pngData(10, 10));
    const limits = { maxChars: 100, maxEdge: 20 };
    const first = await readChatImage(image, { ...limits, versioned: true });
    expect(first.data).toBe(image.data);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    const ifVersion = first.version;
    expect(await readChatImage(image, { ...limits, ifVersion })).toEqual({
      mediaType: "image/png",
      data: "",
      version: ifVersion,
      notModified: true,
    });
    const differentSource = pic(pngData(10, 11));
    const changed = await readChatImage(differentSource, { ...limits, ifVersion });
    expect(changed.data).toBe(differentSource.data);
    expect(changed.version).not.toBe(ifVersion);
    const differentRepresentation = await readChatImage(image, {
      ...limits,
      maxEdge: 21,
      ifVersion,
    });
    expect(differentRepresentation.data).toBe(image.data);
    expect(differentRepresentation.version).not.toBe(ifVersion);
    expect(await readChatImage(image, limits)).not.toHaveProperty("version");
  });

  test.each([
    {
      name: "a PNG over the edge limit",
      image: pic(pngData(400, 800)),
      limits: { maxChars: 100, maxEdge: 360 },
      mediaType: "image/jpeg",
    },
    {
      name: "a PNG over the base64 limit",
      image: pic(pngData(10, 10, 200)),
      limits: { maxChars: 100 },
      mediaType: "image/jpeg",
    },
    {
      name: "a PNG within both limits",
      image: pic(pngData(360, 100)),
      limits: { maxChars: 40, maxEdge: 360 },
      mediaType: "image/png",
    },
    {
      name: "a BMP within both limits",
      image: pic(bmpData(4, 4), "image/bmp"),
      limits: { maxChars: 100, maxEdge: 360 },
      mediaType: "image/jpeg",
    },
  ])("keeps the first response's media type when revalidating $name", async ({
    image,
    limits,
    mediaType,
  }) => {
    const shrink: Shrink = async () => ({
      mediaType: "image/jpeg",
      data: "anBn",
      width: 1,
      height: 1,
    });
    const first = await readChatImage(image, { ...limits, versioned: true }, shrink);
    expect(first.mediaType).toBe(mediaType);
    expect(first.version).toBeDefined();

    const never: Shrink = async () => {
      throw new Error("drawn during revalidation");
    };
    expect(await readChatImage(image, { ...limits, ifVersion: first.version }, never)).toEqual({
      mediaType: first.mediaType,
      data: "",
      version: first.version,
      notModified: true,
    });
  });

  test("asked for one no bigger than it is, goes as it is", async () => {
    const never: Shrink = async () => {
      throw new Error("drawn");
    };
    const data = pngData(300, 200);
    expect(await fitImage(pic(data), { maxChars: 100, maxEdge: 320 }, never)).toEqual({
      mediaType: "image/png",
      data,
      width: 300,
      height: 200,
    });
  });

  test("asked for a smaller one, is drawn with its longer side at that, first", async () => {
    const scales: number[] = [];
    const shrink: Shrink = async (_image, scale) => {
      scales.push(scale);
      return { mediaType: "image/jpeg", data: "jpg", width: Math.round(400 * scale), height: 1 };
    };
    // Tall: its height is the side asked for.
    const fitted = await fitImage(pic(pngData(400, 1600)), { maxChars: 100, maxEdge: 320 }, shrink);
    expect(scales).toEqual([0.2]);
    expect(fitted).toEqual({ mediaType: "image/jpeg", data: "jpg", width: 80, height: 1 });
  });

  test("asked for a smaller one that would still not fit, is drawn smaller again", async () => {
    const scales: number[] = [];
    const shrink: Shrink = async (_image, scale) => {
      scales.push(scale);
      return {
        mediaType: "image/jpeg",
        data: "x".repeat(scales.length === 1 ? 400 : 50),
        width: 1,
        height: 1,
      };
    };
    await fitImage(pic(pngData(1000, 500)), { maxChars: 100, maxEdge: 500 }, shrink);
    expect(scales[0]).toBe(0.5);
    expect(scales[1]).toBeLessThan(0.5);
  });

  test("is drawn smaller till it fits, or given up on", async () => {
    const scales: number[] = [];
    // Each draw comes out a little over what its scale predicts, at first.
    const shrink: Shrink = async (image, scale) => {
      scales.push(scale);
      const chars = Math.round(image.data.length * scale * scale * (scales.length === 1 ? 2 : 1));
      return { mediaType: "image/jpeg", data: "x".repeat(chars), width: 10, height: 10 };
    };
    const big = pngData(800, 600, 1000);
    const fitted = await fitImage(pic(big), { maxChars: 400 }, shrink);
    expect(fitted.data.length).toBeLessThanOrEqual(400);
    expect(scales).toHaveLength(2);
    expect(scales[1]).toBeLessThan(scales[0]);
    const stubborn: Shrink = async () => ({
      mediaType: "image/jpeg",
      data: "x".repeat(500),
      width: 1,
      height: 1,
    });
    await expect(fitImage(pic(big), { maxChars: 400 }, stubborn)).rejects.toThrow("small enough");
  });

  test("of a type the other device does not take is drawn again, though small", async () => {
    let drawn = false;
    const shrink: Shrink = async () => {
      drawn = true;
      return { mediaType: "image/jpeg", data: "jpg", width: 1, height: 1 };
    };
    expect(
      (await fitImage(pic(bmpData(4, 4), "image/bmp"), { maxChars: 100 }, shrink)).mediaType,
    ).toBe("image/jpeg");
    expect(drawn).toBe(true);
  });

  test("not one whose header says it is huge, or tells no size, however small", async () => {
    const never: Shrink = async () => {
      throw new Error("drawn");
    };
    await expect(fitImage(pic(pngData(30_000, 30_000)), { maxChars: 100 }, never)).rejects.toThrow(
      "too big",
    );
    await expect(
      fitImage(pic(bmpData(30_000, 30_000), "image/bmp"), { maxChars: 100 }, never),
    ).rejects.toThrow("too big");
    await expect(fitImage(pic(btoa("not an image")), { maxChars: 100 }, never)).rejects.toThrow(
      "too big",
    );
  });
});
