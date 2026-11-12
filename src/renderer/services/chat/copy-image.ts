// Copying a quick look's image to the clipboard: an image the conversation
// holds (a data URL), or an image file of the workspace, read through the
// workspace so a local and an SSH one copy the same. Whatever its format, it
// is drawn whole and put on the clipboard as a PNG, which every app pastes.

import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { readWorkspaceBinary } from "../editor/preview/read-binary";

/** The type a file's data URL is given, by its extension; the image decoder tells raster formats apart itself. */
function imageType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

/** An image file's bytes as a data URL; null when it could not be read. */
export async function workspaceImageSrc(
  workspaceId: string,
  relPath: string,
): Promise<string | null> {
  const read = await readWorkspaceBinary(workspaceId, relPath);
  if (read.kind !== "ok") return null;
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < read.bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...read.bytes.subarray(i, i + CHUNK));
  }
  return `data:${imageType(relPath)};base64,${btoa(binary)}`;
}

/** The image of a data URL drawn whole, as a PNG data URL. */
export async function pngOf(src: string): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  // An SVG with no size of its own draws at the size HTML gives a replaced element.
  const width = image.naturalWidth || 300;
  const height = image.naturalHeight || 150;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas to draw the image on");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

/** Puts the image of a data URL on the clipboard, as a PNG. */
export async function copyImage(src: string): Promise<void> {
  const pngDataUrl = await pngOf(src);
  unwrapIpcResult(await ipcCallResult("clipboard", "writeImage", { pngDataUrl }));
}
