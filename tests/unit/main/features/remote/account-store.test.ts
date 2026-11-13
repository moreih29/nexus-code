/** Where the sign-in is kept: sealed on disk, or only in memory where it cannot be sealed. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountStore,
  type SecretBox,
} from "../../../../../src/main/features/remote/account-store";

const account = {
  server: "http://localhost:8787",
  token: "tok",
  user: { id: "u1", email: "me@example.com", name: "Me" },
  device: { id: "d1", name: "Mac", platform: "darwin" },
};

/** Seals by reversing the bytes: enough to tell sealed from plain. */
function box(available: boolean): SecretBox {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from(text).reverse(),
    decrypt: (data) => Buffer.from(data).reverse().toString(),
  };
}

const dirs: string[] = [];
function fileIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-account-"));
  dirs.push(dir);
  return join(dir, "sub", "remote-account.bin");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("AccountStore", () => {
  test("seals the sign-in on disk, owner-only, and reads it back", () => {
    const file = fileIn();
    new AccountStore(file, box(true)).save(account);
    expect(readFileSync(file).toString()).not.toContain("tok");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new AccountStore(file, box(true)).load()).toEqual(account);
  });

  test("where nothing seals, keeps it in memory only", () => {
    const file = fileIn();
    const store = new AccountStore(file, box(false));
    store.save(account);
    expect(existsSync(file)).toBe(false);
    expect(store.load()).toEqual(account);
    expect(new AccountStore(file, box(false)).load()).toBeNull();
  });

  test("a damaged file is as good as signed out, and clear removes it", () => {
    const file = fileIn();
    const store = new AccountStore(file, box(true));
    store.save(account);
    writeFileSync(file, "garbage");
    expect(store.load()).toBeNull();
    store.clear();
    expect(existsSync(file)).toBe(false);
  });
});
