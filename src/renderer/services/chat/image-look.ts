import { fileKind } from "./links";
import type { ImageBlock } from "./model";

export interface ShownImage {
  file?: string;
  image?: ImageBlock;
  placed?: true;
}

export interface ImageLook {
  files: string[];
  index: number;
  images: Record<string, ImageBlock>;
  paths?: Record<string, string>;
}

function imageKey(index: number): string {
  return `image:${index + 1}`;
}

export function imageLook(images: readonly ImageBlock[], index: number): ImageLook {
  const files = images.map((_, i) => imageKey(i));
  const at = Math.min(Math.max(0, index), Math.max(0, files.length - 1));
  return {
    files,
    index: at,
    images: Object.fromEntries(files.map((key, i) => [key, images[i]])),
  };
}

function hasData(image: ImageBlock | undefined): image is ImageBlock {
  return image !== undefined && (image.data !== "" || image.remote !== undefined);
}

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

export function shownIndex(shown: readonly ShownImage[], target: ShownImage): number {
  const { file, image } = target;
  if (image) return shown.findIndex((entry) => entry.image && sameImage(entry.image, image));
  if (!file) return -1;
  const bare = shown.findIndex((entry) => entry.file === file && !entry.image);
  return bare >= 0 ? bare : shown.findLastIndex((entry) => entry.file === file);
}

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
    list = list.map((entry, i) => (i === at ? { file: target.file } : entry));
  }
  const wanted = list.flatMap(({ file, image, placed }, i) =>
    file && i !== at && !placed && !hasData(image) ? [file] : [],
  );
  const found = wanted.length > 0 ? await filesThere(wanted) : new Set<string>();
  return conversationLook(list, at, (file) => found.has(file));
}

export function imageSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function imageFileOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as Record<string, unknown>).file_path;
  return typeof path === "string" && path !== "" && fileKind(path) === "image" ? path : undefined;
}

export const LOOK_MARGIN = 64;
export const LOOK_HEADER = 36;
export const LOOK_MIN_WIDTH = 360;

export interface Size {
  w: number;
  h: number;
}

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
