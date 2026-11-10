/**
 * The pictures a browser tab's pick button saves: written where the agent
 * can read them, and dropped once they are a day old.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PICK_PICTURE_MAX_AGE_MS,
  savePickPicture,
} from "../../../../../src/main/features/cli/browser/pick-pictures";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pick-pictures-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A file in `dir` last written `ageMs` before `now`. */
async function fileAged(name: string, now: number, ageMs: number): Promise<void> {
  const file = join(dir, name);
  await writeFile(file, "x");
  const at = (now - ageMs) / 1000;
  await utimes(file, at, at);
}

describe("pick pictures", () => {
  test("older than a day are deleted when one is saved, and nothing else is", async () => {
    const now = Date.now();
    await fileAged("nexus-pick-aaaa-1.png", now, PICK_PICTURE_MAX_AGE_MS + 60_000);
    await fileAged("nexus-pick-bbbb-2.png", now, 60_000);
    await fileAged("nexus-browser-cccc-3.png", now, PICK_PICTURE_MAX_AGE_MS + 60_000);
    await fileAged("notes.txt", now, PICK_PICTURE_MAX_AGE_MS + 60_000);
    await savePickPicture(dir, "dddd", "", now);
    expect((await readdir(dir)).sort()).toEqual([
      "nexus-browser-cccc-3.png",
      "nexus-pick-bbbb-2.png",
      `nexus-pick-dddd-${now}.png`,
      "notes.txt",
    ]);
  });
});
