/**
 * This install of the app, as the server knows it across sign-ins: a random
 * id kept in the app's data folder and sent with each sign-in
 * (device.installId), so that signing in again, after signing out or losing
 * the token, comes back as the same device with its alias rather than a new
 * one. Signing out keeps it. It goes with the data folder, as the sign-in
 * does: a build run with a folder of its own (--user-data-dir) is another
 * device in the room; one run from source with the same product name uses
 * the installed app's folder, so its id and sign-in too.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** What the server takes as an install id. */
export const INSTALL_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The install id kept at `file`, made and kept there the first time. None
 * when it cannot be kept: an id sent once and lost would make each sign-in
 * a new device all the same.
 */
export async function installIdAt(file: string): Promise<string | undefined> {
  const kept = await readFile(file, "utf8").then(
    (text) => text.trim(),
    () => "",
  );
  if (INSTALL_ID.test(kept)) return kept;
  const made = randomBytes(24).toString("base64url");
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, made, { mode: 0o600 });
    return made;
  } catch {
    return undefined;
  }
}
