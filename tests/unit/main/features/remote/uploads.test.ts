/** Files another device sends a piece at a time: in order, the size it said, its own, for a while. */
import { describe, expect, test } from "bun:test";
import { MAX_BYTES_CHUNK, MAX_UPLOAD_BYTES } from "../../../../../packages/remote-protocol/src";
import {
  ATTACHMENT_TTL_MS,
  Attachments,
} from "../../../../../src/main/features/remote/attachments";
import {
  badName,
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOADS_PER_DEVICE,
  Uploads,
} from "../../../../../src/main/features/remote/uploads";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.alloc(10, 7)]);
const b64 = (b: Buffer) => b.toString("base64");

function kit() {
  let clock = 0;
  const attachments = new Attachments(() => clock);
  const uploads = new Uploads(attachments, () => clock);
  return {
    attachments,
    uploads,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("an uploaded file", () => {
  test("comes in pieces, in order, and is kept for the next message as a file", () => {
    const { uploads, attachments } = kit();
    const text = Buffer.from("a,b\n1,2\n");
    const id = uploads.begin("d", "w", "t", { name: "data.csv", size: text.length });
    uploads.chunk("d", id, 0, b64(text.subarray(0, 4)));
    uploads.chunk("d", id, 4, b64(text.subarray(4)));
    const attachmentId = uploads.end("d", id);
    expect(attachments.find("d", "w", "t", [attachmentId])).toEqual([
      { kind: "file", name: "data.csv", data: b64(text) },
    ]);
    // It is done: its id is no more.
    expect(() => uploads.end("d", id)).toThrow("no upload");
  });

  test("an image the chat takes goes as an image, by its bytes; a big one as a file", () => {
    const { uploads, attachments } = kit();
    const send = (name: string, bytes: Buffer, mediaType?: string) => {
      const id = uploads.begin("d", "w", "t", {
        name,
        size: bytes.length,
        ...(mediaType ? { mediaType } : {}),
      });
      for (let at = 0; at < bytes.length; at += MAX_BYTES_CHUNK) {
        uploads.chunk("d", id, at, b64(bytes.subarray(at, at + MAX_BYTES_CHUNK)));
      }
      return attachments.find("d", "w", "t", [uploads.end("d", id)])[0];
    };
    expect(send("shot.png", png)).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: b64(png),
    });
    expect(send("shot", png, "image/png")).toMatchObject({ kind: "image" });
    // Its type says JPEG, its bytes a PNG: a file, as it is.
    expect(send("shot.jpg", png, "image/jpeg")).toMatchObject({ kind: "file", name: "shot.jpg" });
    const big = Buffer.concat([png, Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES)]);
    expect(send("big.png", big, "image/png")).toMatchObject({ kind: "file", name: "big.png" });
  });

  test("a piece out of order, too big or past the size ends the upload", () => {
    const { uploads } = kit();
    const begin = () => uploads.begin("d", "w", "t", { name: "a.bin", size: 8 });
    const late = begin();
    expect(() => uploads.chunk("d", late, 4, b64(Buffer.alloc(4)))).toThrow("in order");
    expect(() => uploads.chunk("d", late, 0, b64(Buffer.alloc(4)))).toThrow("no upload");
    const over = begin();
    expect(() => uploads.chunk("d", over, 0, b64(Buffer.alloc(9)))).toThrow("8 bytes");
    const garbled = begin();
    expect(() => uploads.chunk("d", garbled, 0, "not base64!")).toThrow("base64");
    const huge = uploads.begin("d", "w", "t", { name: "b.bin", size: MAX_BYTES_CHUNK + 1 });
    expect(() => uploads.chunk("d", huge, 0, b64(Buffer.alloc(MAX_BYTES_CHUNK + 1)))).toThrow(
      "at most",
    );
  });

  test("ends only once all its bytes came", () => {
    const { uploads } = kit();
    const id = uploads.begin("d", "w", "t", { name: "a.bin", size: 8 });
    uploads.chunk("d", id, 0, b64(Buffer.alloc(4)));
    expect(() => uploads.end("d", id)).toThrow("4 came");
    expect(() => uploads.end("d", id)).toThrow("no upload");
  });

  test("is refused too big, empty, or with a name that is no file's", () => {
    const { uploads } = kit();
    const begin =
      (name: string, size = 1) =>
      () =>
        uploads.begin("d", "w", "t", { name, size });
    expect(begin("a.bin", MAX_UPLOAD_BYTES + 1)).toThrow("bytes");
    expect(begin("a.bin", 0)).toThrow("bytes");
    expect(begin("../a.bin")).toThrow("folder");
    expect(begin("a\\b.bin")).toThrow("folder");
    expect(begin("..")).toThrow("name");
    expect(begin("a\nb")).toThrow("control");
    expect(badName(" notes.md ")).toBeNull();
  });

  test("is the device's own, and dropped after ten minutes without a piece", () => {
    const { uploads, tick } = kit();
    const id = uploads.begin("d", "w", "t", { name: "a.bin", size: 8 });
    expect(() => uploads.chunk("other", id, 0, b64(Buffer.alloc(4)))).toThrow("no upload");
    tick(ATTACHMENT_TTL_MS - 1);
    uploads.chunk("d", id, 0, b64(Buffer.alloc(4)));
    tick(ATTACHMENT_TTL_MS - 1);
    uploads.chunk("d", id, 4, b64(Buffer.alloc(4)));
    tick(ATTACHMENT_TTL_MS);
    expect(() => uploads.end("d", id)).toThrow("no upload");
  });

  test("a device has only so many under way: its oldest goes", () => {
    const { uploads } = kit();
    const ids = Array.from({ length: MAX_UPLOADS_PER_DEVICE + 1 }, () =>
      uploads.begin("d", "w", "t", { name: "a.bin", size: 1 }),
    );
    expect(() => uploads.chunk("d", ids[0] ?? "", 0, b64(Buffer.alloc(1)))).toThrow("no upload");
    uploads.chunk("d", ids[1] ?? "", 0, b64(Buffer.alloc(1)));
  });
});
