/**
 * The images a chat shows, as quick look opens them: all of the
 * conversation's images, in the order they came, each a step from the next.
 * An image file shows as the file; one with no file (a screenshot a tool
 * took, an image the user pasted) from its data, as does a file that is
 * gone, from the data a tool read it as. Pure.
 */

import { fileKind } from "./links";
import type { ImageBlock } from "./model";

/** An image a conversation shows (panel's imagesOf). */
export interface ShownImage {
  /** The image file, by its absolute path. */
  file?: string;
  /** Its data, as a tool or the user gave it. */
  image?: ImageBlock;
}

/** Quick look over images: each by its path, or by a key, which no path is, and its data. */
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

/**
 * Where among `shown` an image is: an image file by its path, one with no
 * file by its data (the same block, or one with the same bytes); -1 when it
 * is not among them.
 */
export function shownIndex(shown: readonly ShownImage[], target: ShownImage): number {
  const { file, image } = target;
  if (file) return shown.findIndex((entry) => entry.file === file);
  if (!image) return -1;
  const at = shown.findIndex((entry) => entry.image === image);
  if (at >= 0) return at;
  return shown.findIndex(
    (entry) => entry.image?.data === image.data && entry.image.mediaType === image.mediaType,
  );
}

/**
 * Quick look over a conversation's images (`shown`), at the one at `at`.
 * An image file shows as the file when `there` finds it, from its data
 * otherwise; one gone with no data is left out, unless it is the one opened.
 */
export function conversationLook(
  shown: readonly ShownImage[],
  at: number,
  there: (file: string) => boolean,
): ImageLook {
  const files: string[] = [];
  const images: Record<string, ImageBlock> = {};
  let keys = 0;
  let index = 0;
  shown.forEach(({ file, image }, i) => {
    if (i === at) index = files.length;
    if (file && (there(file) || (i === at && !image))) {
      files.push(file);
    } else if (image) {
      const key = imageKey(keys++);
      images[key] = image;
      files.push(key);
    }
  });
  return { files, index, images };
}

/**
 * Quick look over a conversation's images, at `target`: the image file
 * opened, by its path, or an image with no file, by its data. An image file
 * not among them comes first; an image with no file not among them gives
 * null. `filesThere` answers which image files are there.
 */
export async function lookAtImage(
  shown: readonly ShownImage[],
  target: ShownImage,
  filesThere: (files: string[]) => Promise<ReadonlySet<string>>,
): Promise<ImageLook | null> {
  let list = shown;
  let at = shownIndex(shown, target);
  if (at < 0) {
    if (!target.file) return null;
    list = [{ file: target.file }, ...shown];
    at = 0;
  }
  const found = await filesThere(list.flatMap(({ file }) => (file ? [file] : [])));
  return conversationLook(list, at, (file) => found.has(file));
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
