import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const INSTALL_ID = /^[A-Za-z0-9_-]{16,128}$/;

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
