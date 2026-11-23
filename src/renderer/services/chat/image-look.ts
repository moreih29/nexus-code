/**
 * The images a chat shows, as quick look opens them: all of the
 * conversation's images, in the order they came, each a step from the next.
 * An image with its data (as a tool read it, a screenshot it took, one the
 * user pasted) shows from it, each read of a file as it was; one with none
 * shows as the file. Pure.
 */

import { fileKind } from "./links";
import type { ImageBlock } from "./model";

/** An image a conversation shows (panel's imagesOf). */
export interface ShownImage {
  /** The image file, by its absolute path. */
  file?: string;
  /** Its data, as a tool or the user gave it. */
  image?: ImageBlock;
  /**
   * The file is shown in full where the conversation names it (sent the
   * user, or ![alt](path) in a reply), which lets the previews read it.
   */
  placed?: true;
}

/**
 * Quick look over images: each by its path, or by a key, which no path is,
 * and its data. `paths` names the file an image held by a key was read
 * from, which the file's own actions (open as a tab, reveal) still use.
 */
export interface ImageLook {
  files: string[];
  index: number;
  images: Record<string, ImageBlock>;
  paths?: Record<string, string>;
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

/** Whether an image has its bytes, or can have them fetched (another computer's). */
function hasData(image: ImageBlock | undefined): image is ImageBlock {
  return image !== undefined && (image.data !== "" || image.remote !== undefined);
}

/**
 * Whether two blocks are the one image: the same block, or, for another
 * computer's (whose blocks are made anew as its chat syncs), the same
 * reference. Never by bytes: two images can have the same ones.
 */
export function sameImage(a: ImageBlock, b: ImageBlock): boolean {
  if (a === b) return true;
  const x = a.remote;
  const y = b.remote;
  if (!x || !y || x.kind !== y.kind || x.index !== y.index) return false;
  if (x.kind === "user" && y.kind === "user") return x.itemKey === y.itemKey;
  if (x.kind === "tool" && y.kind === "tool") return x.toolUseId === y.toolUseId;
  if (x.kind === "held" && y.kind === "held") return x.id === y.id;
  return false;
}

/**
 * Where among `shown` an image is: the one that is the target's image (see
 * sameImage), so one of several reads of the same file is the one clicked;
 * or, a file with no image, the entry that has the file and no data, else
 * the last one with it. -1 when it is not among them.
 */
export function shownIndex(shown: readonly ShownImage[], target: ShownImage): number {
  const { file, image } = target;
  if (image) return shown.findIndex((entry) => entry.image && sameImage(entry.image, image));
  if (!file) return -1;
  const bare = shown.findIndex((entry) => entry.file === file && !entry.image);
  return bare >= 0 ? bare : shown.findLastIndex((entry) => entry.file === file);
}

/**
 * The file of the image `target` is, when it is the last read of that file
 * among `shown`: the one the file as it is now shows, which a panel holding
 * the file stands for. undefined for an earlier read, or a target with no
 * file or not among them.
 */
export function latestReadFile(
  shown: readonly ShownImage[],
  target: ShownImage,
): string | undefined {
  const at = shownIndex(shown, target);
  const file = at >= 0 ? shown[at].file : undefined;
  return file !== undefined && shown.findLastIndex((entry) => entry.file === file) === at
    ? file
    : undefined;
}

/**
 * Quick look over a conversation's images (`shown`), at the one at `at`.
 * An image with its data shows from it, as it was read, and keeps its file
 * for the file's actions; one with none shows as the file when `there` finds
 * it, or when the conversation shows it in full (`placed`), as it does the
 * one opened: what the chat shows stays a step away, whatever a lookup at
 * the moment answers. One only named, gone, with no data is left out.
 */
export function conversationLook(
  shown: readonly ShownImage[],
  at: number,
  there: (file: string) => boolean,
): ImageLook {
  const files: string[] = [];
  const images: Record<string, ImageBlock> = {};
  const paths: Record<string, string> = {};
  let keys = 0;
  let index = 0;
  shown.forEach(({ file, image, placed }, i) => {
    if (i === at) index = files.length;
    const asFile = file !== undefined && (there(file) || (!image && (i === at || placed === true)));
    if (hasData(image) || (image && !asFile)) {
      const key = imageKey(keys++);
      images[key] = image;
      if (file) paths[key] = file;
      files.push(key);
    } else if (asFile) {
      files.push(file);
    }
  });
  return { files, index, images, ...(Object.keys(paths).length > 0 ? { paths } : {}) };
}

/**
 * Quick look over a conversation's images, at `target`: the image opened
 * (by the block, as another computer's ref, or the file, which shows as the
 * file as it is now). An image file not among them comes first; an image
 * with no file not among them gives null. `filesThere` answers which image
 * files are there.
 */
export async function lookAtImage(
  shown: readonly ShownImage[],
  target: ShownImage,
  filesThere: (files: string[]) => Promise<ReadonlySet<string>>,
): Promise<ImageLook | null> {
  let list = shown;
  let at = shownIndex(shown, target);
  if (at < 0) {
    if (!target.file || target.image) return null;
    list = [{ file: target.file }, ...shown];
    at = 0;
  } else if (!target.image && target.file && list[at].image) {
    // A link to the file shows the file, not what a read of it once gave.
    list = list.map((entry, i) => (i === at ? { file: target.file } : entry));
  }
  // Only an image the chat shows no data or picture of waits on its file
  // being found: each lookup is a call to the files' host, and a long
  // conversation has hundreds of images.
  const wanted = list.flatMap(({ file, image, placed }, i) =>
    file && i !== at && !placed && !hasData(image) ? [file] : [],
  );
  const found = wanted.length > 0 ? await filesThere(wanted) : new Set<string>();
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

/** How far in from the area's edges quick look keeps an image, leaving room around it to click away. */
export const LOOK_MARGIN = 64;
/** The height of quick look's header, above the image. */
export const LOOK_HEADER = 36;
/** The narrowest quick look gets around an image, for its header. */
export const LOOK_MIN_WIDTH = 360;

export interface Size {
  w: number;
  h: number;
}

/**
 * Quick look's size around an image of `natural` size, over an area of
 * `area`: the image fitted to the area LOOK_MARGIN in, under the header,
 * made larger or smaller to fit, so every image shows as large as the box
 * lets it; with `frame` for the border. Never narrower than LOOK_MIN_WIDTH,
 * where the area has room. Null where it has none, or the size is unknown.
 */
export function imageLookSize(area: Size, natural: Size, frame = 0): Size | null {
  if (natural.w <= 0 || natural.h <= 0) return null;
  const boxW = area.w - 2 * LOOK_MARGIN - frame;
  const boxH = area.h - 2 * LOOK_MARGIN - LOOK_HEADER - frame;
  if (boxW <= 0 || boxH <= 0) return null;
  const fit = Math.min(boxW / natural.w, boxH / natural.h);
  const w = Math.floor(natural.w * fit);
  const h = Math.floor(natural.h * fit);
  return {
    w: Math.max(w, Math.min(LOOK_MIN_WIDTH, area.w - 2 * LOOK_MARGIN - frame)) + frame,
    h: h + LOOK_HEADER + frame,
  };
}
