import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  readPickedAttachment,
  readWindowsPickedAttachment,
  registerPickedAttachmentHandler,
} from "../../../../../src/main/features/fs/picked-attachment";
import { MAX_READABLE_FILE_SIZE } from "../../../../../src/shared/fs/defaults";
import {
  isWindowsLongPath,
  READ_PICKED_ATTACHMENT,
} from "../../../../../src/shared/fs/picked-attachment";

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

test.each([
  ["non-Windows", `C:\\${"q".repeat(257)}`, "linux"],
  ["259 characters", `C:\\${"q".repeat(256)}`, "win32"],
  ["relative path", "q".repeat(260), "win32"],
  ["non-string path", { path: `C:\\${"q".repeat(257)}` }, "win32"],
] as const)("rejects %s at the Windows attachment gate", async (_case, path, platform) => {
  expect(await readWindowsPickedAttachment(path, platform)).toBeNull();
});

test("accepts a Windows attachment path at exactly 260 characters", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nexus-picked-"));
  const path = join(folder, "q".repeat(260 - folder.length - 1));
  expect(isWindowsLongPath(path.slice(0, -1))).toBe(false);
  expect(path).toHaveLength(260);
  expect(isWindowsLongPath(path)).toBe(true);
  await writeFile(path, "x");
  try {
    expect(await readWindowsPickedAttachment(path, "win32")).toEqual({
      size: 1,
      bytes: Uint8Array.of(120),
    });
  } finally {
    await unlink(path);
    await rmdir(folder);
  }
});

test("returns the disk size and no bytes above the preview limit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nexus-picked-"));
  const path = join(folder, "large.txt");
  const size = MAX_READABLE_FILE_SIZE + 1;
  await writeFile(path, "x");
  try {
    await truncate(path, size);
    expect(await readPickedAttachment(path)).toEqual({ size, bytes: null });
  } finally {
    await unlink(path);
    await rmdir(folder);
  }
});

function pickedAttachmentHandler(
  isAppWindow: Parameters<typeof registerPickedAttachmentHandler>[1],
  read: Parameters<typeof registerPickedAttachmentHandler>[2],
) {
  const handle = mock((_channel: string, _listener: Parameters<IpcMain["handle"]>[1]) => {});
  registerPickedAttachmentHandler({ handle }, isAppWindow, read);
  expect(handle).toHaveBeenCalledTimes(1);
  const [channel, listener] = handle.mock.calls[0] ?? [];
  expect(channel).toBe(READ_PICKED_ATTACHMENT);
  if (!listener) throw new Error("Expected a registered attachment listener");
  return listener;
}

const mainFrame = { routingId: 42 };
const childFrame = { routingId: 43 };
function invokeEvent(id: number, senderFrame: typeof mainFrame | null): IpcMainInvokeEvent {
  return { sender: { id, mainFrame }, senderFrame } as IpcMainInvokeEvent;
}

test("requires a registered app window and its main frame to read an attachment", async () => {
  const result = { size: 1, bytes: Uint8Array.of(120) };
  const read = mock(async (_path: unknown) => result);
  const listener = pickedAttachmentHandler((sender) => sender.id === 1, read);
  const path = `C:\\${"q".repeat(257)}`;

  expect(await listener(invokeEvent(2, mainFrame), path)).toBeNull();
  expect(await listener(invokeEvent(1, childFrame), path)).toBeNull();
  expect(await listener(invokeEvent(1, null), path)).toBeNull();
  expect(read).not.toHaveBeenCalled();

  expect(await listener(invokeEvent(1, mainFrame), path)).toEqual(result);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(path);
});

test("returns null when the attachment read fails with a path-bearing error", async () => {
  const listener = pickedAttachmentHandler(
    () => true,
    async (path) => {
      throw Object.assign(new Error(`ENOENT opening ${path}`), { code: "ENOENT" });
    },
  );
  expect(await listener(invokeEvent(1, mainFrame), "C:\\missing.txt")).toBeNull();
});
