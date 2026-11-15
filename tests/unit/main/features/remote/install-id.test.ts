/**
 * This install's id: made once, kept in the app's data folder, and sent
 * with each sign-in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_ID, installIdAt } from "../../../../../src/main/features/remote/install-id";

const dirs: string[] = [];
async function dir(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "install-id-"));
  dirs.push(made);
  return made;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o700).catch(() => {});
    await rm(d, { recursive: true, force: true });
  }
});

describe("the install id", () => {
  test("is made the first time, as the server takes one, and kept", async () => {
    const file = join(await dir(), "remote-install-id");
    const first = await installIdAt(file);
    expect(first).toMatch(INSTALL_ID);
    expect(first).toHaveLength(32);
    expect(await readFile(file, "utf8")).toBe(first as string);
    expect(await installIdAt(file)).toBe(first);
  });

  test("one not of the server's form is made anew", async () => {
    const file = join(await dir(), "remote-install-id");
    await writeFile(file, "short");
    const made = await installIdAt(file);
    expect(made).toMatch(INSTALL_ID);
    expect(await installIdAt(file)).toBe(made);
  });

  test.skipIf(process.platform === "win32")("none when it cannot be kept", async () => {
    const folder = await dir();
    await chmod(folder, 0o500);
    expect(await installIdAt(join(folder, "remote-install-id"))).toBeUndefined();
  });
});
