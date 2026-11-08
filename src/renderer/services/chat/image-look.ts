/**
 * The images a chat shows, as quick look opens them. An image a tool read
 * from a file opens as that file, among the session's results; one with no
 * file (a screenshot a tool took, an image the user pasted) opens from its
 * data, with the images beside it a step away. Pure.
 */

import { fileKind } from "./links";
import type { ImageBlock } from "./model";

/** Quick look over images with no file: each by a key, which no path is, and its data. */
export interface ImageLook {
  files: string[];
  index: number;
  images: Record<string, ImageBlock>;
}

/** The key quick look holds the image at `index` by: no path starts so. */
function imageKey(index: number): string {
  return `image:${index + 1}`;
}

/** Quick look over `images`, at the one at `index`. */
export function imageLook(images: readonly ImageBlock[], index: number): ImageLook {
  const files = images.map((_, i) => imageKey(i));
  const at = Math.min(Math.max(0, index), Math.max(0, files.length - 1));
  return {
    files,
    index: at,
    images: Object.fromEntries(files.map((key, i) => [key, images[i]])),
  };
}

/** The image as a URL an <img> shows. */
export function imageSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/**
 * The image file a tool's images came from, as a Read or a ViewImage of
 * it; undefined for a tool that read no image file, as one that took a
 * screenshot, or read a notebook with images in it.
 */
export function imageFileOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as Record<string, unknown>).file_path;
  return typeof path === "string" && path !== "" && fileKind(path) === "image" ? path : undefined;
}
