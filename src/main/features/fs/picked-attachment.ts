import { open } from "node:fs/promises";
import { win32 } from "node:path";
import type { IpcMain } from "electron";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import {
  isWindowsLongPath,
  type PickedAttachment,
  READ_PICKED_ATTACHMENT,
} from "../../../shared/fs/picked-attachment";
import { appWindowOf } from "../window/app-windows";

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

export function readWindowsPickedAttachment(
  path: unknown,
  platform: NodeJS.Platform = process.platform,
): Promise<PickedAttachment> | null {
  if (
    platform !== "win32" ||
    typeof path !== "string" ||
    !isWindowsLongPath(path) ||
    !win32.isAbsolute(path)
  ) {
    return null;
  }
  return readPickedAttachment(path);
}

export function registerPickedAttachmentHandler(
  ipc: Pick<IpcMain, "handle">,
  isAppWindow = (sender: { readonly id: number }) => appWindowOf(sender) !== null,
  read = readWindowsPickedAttachment,
): void {
  ipc.handle(READ_PICKED_ATTACHMENT, async (event, path: unknown) => {
    try {
      if (
        !isAppWindow(event.sender) ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        return null;
      }
      return await read(path);
    } catch {
      return null;
    }
  });
}
