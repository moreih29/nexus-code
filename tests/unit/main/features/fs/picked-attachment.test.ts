import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPickedAttachment } from "../../../../../src/main/features/fs/picked-attachment";

test("reads only the supplied file and accepts actual empty content", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-picked-"));
  const folder = join(root, "q".repeat(150));
  const selected = join(folder, `${"a".repeat(100)}.txt`);
  const sibling = join(folder, "sibling.txt");
  await mkdir(folder);
  await writeFile(selected, "selected");
  await writeFile(sibling, "sibling");
  try {
    const read = await readPickedAttachment(selected);
    expect(read.size).toBe(8);
    expect(new TextDecoder().decode(read.bytes ?? undefined)).toBe("selected");
    await writeFile(selected, "");
    expect(await readPickedAttachment(selected)).toEqual({ size: 0, bytes: new Uint8Array() });
    await expect(readPickedAttachment(folder)).rejects.toThrow();
    await expect(readPickedAttachment(join(folder, "missing.txt"))).rejects.toThrow();
  } finally {
    await unlink(selected);
    await unlink(sibling);
    await rmdir(folder);
    await rmdir(root);
  }
});
