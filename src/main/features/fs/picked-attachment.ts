import { open } from "node:fs/promises";
import { win32 } from "node:path";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { isWindowsLongPath, type PickedAttachment } from "../../../shared/fs/picked-attachment";

export async function readPickedAttachment(path: string): Promise<PickedAttachment> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Attachment is not a file");
    const { size } = stat;
    const tooLarge = size > MAX_READABLE_FILE_SIZE;
    const bytes = new Uint8Array(tooLarge ? 1 : size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Attachment changed while reading");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== size) throw new Error("Attachment changed while reading");
    return { size, bytes: tooLarge ? null : bytes };
  } finally {
    await file.close();
  }
}

export function readWindowsPickedAttachment(path: unknown): Promise<PickedAttachment> | null {
  if (
    process.platform !== "win32" ||
    typeof path !== "string" ||
    !isWindowsLongPath(path) ||
    !win32.isAbsolute(path)
  ) {
    return null;
  }
  return readPickedAttachment(path);
}
