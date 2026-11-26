import { describe, expect, mock, test } from "bun:test";
import { prepareLongPathAttachment } from "../../../../../src/renderer/services/chat/picked-attachment";
import { MAX_READABLE_FILE_SIZE } from "../../../../../src/shared/fs/defaults";

describe("prepareLongPathAttachment", () => {
  test("keeps a readable browser file", async () => {
    const file = new File(["healthy"], "note.txt");
    const recover = mock(async () => null);
    expect(await prepareLongPathAttachment(file, 0, recover)).toEqual({ file });
    expect(recover).not.toHaveBeenCalled();
  });

  test("recovers a zero-size browser file using only the selected File", async () => {
    const file = new File([], "note.txt", { type: "text/plain", lastModified: 42 });
    const bytes = new TextEncoder().encode("recovered");
    const recover = mock(async (_selected: File) => ({ size: bytes.length, bytes }));
    const prepared = await prepareLongPathAttachment(file, 0, recover);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]?.[0]).toBe(file);
    expect(await prepared.file.text()).toBe("recovered");
    expect(prepared.file.name).toBe(file.name);
    expect(prepared.file.type).toBe(file.type);
    expect(prepared.file.lastModified).toBe(42);
  });

  test("recovers when a nonempty browser file fails to read", async () => {
    const file = new File(["browser"], "note.txt");
    file.arrayBuffer = mock(async () => {
      throw new Error("NotFoundError");
    });
    const bytes = new TextEncoder().encode("disk");
    const prepared = await prepareLongPathAttachment(file, 0, async () => ({
      size: bytes.length,
      bytes,
    }));
    expect(await prepared.file.text()).toBe("disk");
  });

  test("keeps a verified empty file without an empty inline image", async () => {
    const prepared = await prepareLongPathAttachment(new File([], "empty.png"), 100, async () => ({
      size: 0,
      bytes: new Uint8Array(),
    }));
    expect(prepared.file.size).toBe(0);
    expect(prepared.image).toBeUndefined();
  });

  test("returns the disk size when an attachment exceeds the preview limit", async () => {
    const file = new File([], "large.txt");
    const size = MAX_READABLE_FILE_SIZE + 1;
    expect(await prepareLongPathAttachment(file, 0, async () => ({ size, bytes: null }))).toEqual({
      file,
      unbufferedSize: size,
    });
  });

  test("blocks the file when recovery cannot read it", async () => {
    const file = new File([], "missing.txt");
    await expect(prepareLongPathAttachment(file, 0, async () => null)).rejects.toThrow();
    await expect(
      prepareLongPathAttachment(file, 0, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("ENOENT");
  });
});
