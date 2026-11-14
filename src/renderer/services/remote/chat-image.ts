/**
 * An image of a chat as another device asks for it (chat.image): a user
 * message's or a tool result's, sent as it is when it fits in a frame and
 * is of a type the other device takes, else drawn smaller as a JPEG till
 * it fits. Not one whose header says it is huge, or tells no size: drawing
 * it would decode all of it, here or there (a decompression bomb).
 */

import type { CliChatImage } from "../../../shared/cli/ui";
import { decodable } from "../../../shared/remote/image-size";
import type { ImageBlock } from "../chat/model";
import { UiRequestError } from "../cli/handler";
import { type ChatSource, conversationOf } from "./chat-page";

export type ChatImageRef =
  | { kind: "user"; itemKey: string; index: number }
  | { kind: "tool"; toolUseId: string; index: number };

const SENT_AS_IS: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** How many times an image is drawn smaller before it is given up on. */
const MAX_TRIES = 6;

/** The image the ref names in the tab's conversation; null when there is none. */
export function imageOf(source: ChatSource, ref: ChatImageRef): ImageBlock | null {
  const { items, tools } = conversationOf(source);
  if (ref.kind === "user") {
    const item = items.find((i) => i.key === ref.itemKey);
    return item?.kind === "user" ? (item.images[ref.index] ?? null) : null;
  }
  return tools[ref.toolUseId]?.result?.images[ref.index] ?? null;
}

/** The image drawn at `scale` of its size, as a JPEG. */
export type Shrink = (image: ImageBlock, scale: number) => Promise<Required<CliChatImage>>;

/** The image, as it is or drawn smaller, its base64 at most `maxChars`. */
export async function fitImage(
  image: ImageBlock,
  maxChars: number,
  shrink: Shrink = shrinkOnCanvas,
): Promise<CliChatImage> {
  if (!decodable(bytesOf(image.data))) {
    throw new UiRequestError("the image is too big to draw, by its header, or not one read here");
  }
  if (SENT_AS_IS.has(image.mediaType) && image.data.length <= maxChars) {
    return { mediaType: image.mediaType as CliChatImage["mediaType"], data: image.data };
  }
  // Drawn whole first: a JPEG may take far less than the PNG it was. Then
  // smaller as its base64 grows with the pixels, by the square root of the
  // share to lose, and a little more.
  let scale = 1;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const shrunk = await shrink(image, scale);
    if (shrunk.data.length <= maxChars) return shrunk;
    scale *= Math.sqrt(maxChars / shrunk.data.length) * 0.9;
  }
  throw new UiRequestError("the image would not get small enough to send");
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const shrinkOnCanvas: Shrink = async (image, scale) => {
  const bytes = bytesOf(image.data);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: image.mediaType }));
  } catch {
    throw new UiRequestError(`the ${image.mediaType} image could not be read here`);
  }
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new UiRequestError("no canvas to draw the image on");
  // A JPEG has no transparency: what was clear shows white, as on a page.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return {
    mediaType: "image/jpeg",
    data: base64Of(new Uint8Array(await blob.arrayBuffer())),
    width,
    height,
  };
};
