/**
 * The pictures of elements picked with a browser tab's button, kept in this
 * machine's temp directory for the agent to read. Each save drops those
 * older than a day, so they do not pile up.
 */
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How long a picture is kept. */
export const PICK_PICTURE_MAX_AGE_MS = 24 * 60 * 60_000;

const PICTURE_NAME = /^nexus-pick-[\w-]+\.png$/;

/** Saves `png` (base64) in `dir` as nexus-pick-TAB-TIME.png and returns its path. */
export async function savePickPicture(
  dir: string,
  tab: string,
  png: string,
  now: number,
): Promise<string> {
  const file = join(dir, `nexus-pick-${tab}-${now}.png`);
  await writeFile(file, Buffer.from(png, "base64"));
  await prunePickPictures(dir, now);
  return file;
}

/** Deletes the pictures in `dir` last written more than `maxAgeMs` before `now`. */
export async function prunePickPictures(
  dir: string,
  now: number,
  maxAgeMs = PICK_PICTURE_MAX_AGE_MS,
): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => PICTURE_NAME.test(name))
      .map(async (name) => {
        const file = join(dir, name);
        try {
          if (now - (await stat(file)).mtimeMs > maxAgeMs) await unlink(file);
        } catch {
          // Gone already, or not ours to delete.
        }
      }),
  );
}
