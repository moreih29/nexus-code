import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PICK_PICTURE_MAX_AGE_MS = 24 * 60 * 60_000;

const PICTURE_NAME = /^nexus-pick-[\w-]+\.png$/;

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
        } catch {}
      }),
  );
}
