import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { readWorkspaceBinary } from "../editor/preview/read-binary";

function imageType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

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

export async function pngOf(src: string): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
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

export async function copyImage(src: string): Promise<void> {
  const pngDataUrl = await pngOf(src);
  unwrapIpcResult(await ipcCallResult("clipboard", "writeImage", { pngDataUrl }));
}
