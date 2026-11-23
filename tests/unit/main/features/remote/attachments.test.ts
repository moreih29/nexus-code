import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../../../../packages/remote-protocol/src";
import {
  ATTACHMENT_TTL_MS,
  Attachments,
  looksLike,
  MAX_KEPT_BYTES_PER_DEVICE,
  MAX_KEPT_PER_DEVICE,
} from "../../../../../src/main/features/remote/attachments";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.alloc(10)]);
const image = { mediaType: "image/png", data: png.toString("base64") };

describe("an attached image", () => {
  test("is what its type says, by its first bytes", () => {
    expect(looksLike("image/png", png)).toBe(true);
    expect(looksLike("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLike("image/gif", Buffer.from("GIF89a"))).toBe(true);
    expect(looksLike("image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(looksLike("image/jpeg", png)).toBe(false);
  });

  test("is refused when it is no base64, too big, or not its type", () => {
    const kept = new Attachments();
    const take = (over: Partial<typeof image>) => () =>
      kept.take("d", "w", "t", { ...image, ...over });
    expect(take({ data: "not base64!" })).toThrow("base64");
    const big = Buffer.concat([png, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    expect(take({ data: big.toString("base64") })).toThrow("bytes");
    expect(take({ mediaType: "image/jpeg" })).toThrow("image/jpeg");
  });

  test("is found by the device and chat it was for, and goes once sent", () => {
    const kept = new Attachments();
    const id = kept.take("d", "w", "t", image);
    expect(() => kept.find("other", "w", "t", [id])).toThrow("no image");
    expect(() => kept.find("d", "w", "t2", [id])).toThrow("another chat");
    expect(kept.find("d", "w", "t", [id])).toEqual([{ kind: "image", ...image }]);
    kept.drop([id]);
    expect(() => kept.find("d", "w", "t", [id])).toThrow("no image");
  });

  test("waits ten minutes, and a device keeps only so many", () => {
    let clock = 0;
    const kept = new Attachments(() => clock);
    const first = kept.take("d", "w", "t", image);
    clock = ATTACHMENT_TTL_MS;
    expect(() => kept.find("d", "w", "t", [first])).toThrow("no image");
    const ids = Array.from({ length: MAX_KEPT_PER_DEVICE + 1 }, () =>
      kept.take("d", "w", "t", image),
    );
    expect(() => kept.find("d", "w", "t", [ids[0]])).toThrow("no image");
    expect(kept.find("d", "w", "t", ids.slice(1))).toHaveLength(MAX_KEPT_PER_DEVICE);
  });

  test("a device's files take only so many bytes: its oldest go to make room", () => {
    const kept = new Attachments();
    const half = MAX_KEPT_BYTES_PER_DEVICE / 2;
    const file = (name: string) => ({ kind: "file" as const, name, data: "" });
    const first = kept.hold("d", "w", "t", file("a.pdf"), half);
    const second = kept.hold("d", "w", "t", file("b.pdf"), half);
    const third = kept.hold("d", "w", "t", file("c.pdf"), 1);
    expect(() => kept.find("d", "w", "t", [first])).toThrow("no image or file");
    expect(kept.find("d", "w", "t", [second, third]).map((h) => h.kind)).toEqual(["file", "file"]);
    expect(kept.find("d", "w", "t", [third])).toEqual([file("c.pdf")]);
    expect(kept.hold("e", "w", "t", file("d.pdf"), half)).toBeString();
    expect(kept.find("d", "w", "t", [second])).toHaveLength(1);
  });
});
