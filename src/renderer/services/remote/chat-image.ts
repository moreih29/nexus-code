import type { CliChatImage } from "../../../shared/cli/ui";
import { decodable, pixelSizeOf } from "../../../shared/remote/image-size";
import type { ImageBlock } from "../chat/model";
import { UiRequestError } from "../cli/handler";
import { type ChatSource, conversationOf } from "./chat-page";

export type ChatImageRef =
  | { kind: "user"; itemKey: string; index: number }
  | { kind: "tool"; toolUseId: string; index: number }
  | { kind: "held"; id: string; index: number };

const SENT_AS_IS: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const MAX_TRIES = 6;

export function imageOf(source: ChatSource, ref: ChatImageRef): ImageBlock | null {
  if (ref.kind === "held") {
    return source.chat.queue.find((q) => q.id === ref.id)?.images[ref.index] ?? null;
  }
  const { items, tools } = conversationOf(source);
  if (ref.kind === "user") {
    const item = items.find((i) => i.key === ref.itemKey);
    return item?.kind === "user" ? (item.images[ref.index] ?? null) : null;
  }
  return tools[ref.toolUseId]?.result?.images[ref.index] ?? null;
}

export type Shrink = (image: ImageBlock, scale: number) => Promise<Required<CliChatImage>>;

export interface ImageLimits {
  maxChars: number;
  maxEdge?: number;
}

function planImageFit(image: ImageBlock, { maxChars, maxEdge }: ImageLimits) {
  const bytes = bytesOf(image.data);
  const size = decodable(bytes) ? pixelSizeOf(bytes) : null;
  if (!size) {
    throw new UiRequestError("the image is too big to draw, by its header, or not one read here");
  }
  const edge = Math.max(size.width, size.height);
  const scale = maxEdge !== undefined && edge > maxEdge ? maxEdge / edge : 1;
  const sendAsIs = scale === 1 && SENT_AS_IS.has(image.mediaType) && image.data.length <= maxChars;
  return { size, scale, sendAsIs };
}

export async function fitImage(
  image: ImageBlock,
  limits: ImageLimits,
  shrink: Shrink = shrinkOnCanvas,
): Promise<Required<CliChatImage>> {
  const { maxChars } = limits;
  const plan = planImageFit(image, limits);
  if (plan.sendAsIs) {
    return {
      mediaType: image.mediaType as CliChatImage["mediaType"],
      data: image.data,
      width: plan.size.width,
      height: plan.size.height,
    };
  }
  let scale = plan.scale;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const shrunk = await shrink(image, scale);
    if (shrunk.data.length <= maxChars) return shrunk;
    scale *= Math.sqrt(maxChars / shrunk.data.length) * 0.9;
  }
  throw new UiRequestError("the image would not get small enough to send");
}

export async function readChatImage(
  image: ImageBlock,
  limits: ImageLimits & { versioned?: true; ifVersion?: string },
  shrink: Shrink = shrinkOnCanvas,
): Promise<CliChatImage & { version?: string; notModified?: true }> {
  const { versioned, ifVersion, maxChars, maxEdge } = limits;
  if ((!versioned && ifVersion === undefined) || !globalThis.crypto?.subtle) {
    return fitImage(image, limits, shrink);
  }
  const source = new TextEncoder().encode(
    JSON.stringify([1, image.mediaType, maxChars, maxEdge]) + image.data,
  );
  const digest = await crypto.subtle.digest("SHA-256", source);
  const version = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (version === ifVersion) {
    const mediaType = planImageFit(image, limits).sendAsIs
      ? (image.mediaType as CliChatImage["mediaType"])
      : "image/jpeg";
    return { mediaType, data: "", version, notModified: true };
  }
  return { ...(await fitImage(image, limits, shrink)), version };
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
