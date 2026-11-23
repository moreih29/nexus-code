/**
 * A file of the app's own, sealed with the system's keychain (Electron
 * safeStorage): where the NexusCode sign-in and the account key are kept.
 * Where the system has none to seal with (Linux without a keyring), nothing
 * is written: what would be kept lasts until the app quits.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * The keychain did not open: the user put it off, or refused macOS's
 * prompt. Not a damaged file: what is sealed stays as it is.
 */
export class KeychainLockedError extends Error {
  constructor() {
    super("The keychain is locked");
    this.name = "KeychainLockedError";
  }
}

/** What seals and opens the file. */
export interface SecretBox {
  /** Whether it seals for real: false where it would write plain text. */
  readonly available: boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

/**
 * The system's keychain, through Electron's asynchronous safeStorage.
 *
 * A Mac always has a keychain, and asking whether it is there reads it:
 * isAsyncEncryptionAvailable fetches the key, and macOS asks for the login
 * password when the item's access list does not name this app's signature.
 * So on macOS the keychain is read only when something is sealed or opened.
 */
export async function electronSecretBox(platform = process.platform): Promise<SecretBox> {
  const { safeStorage } = await import("electron");
  const available =
    platform === "darwin" ||
    ((await safeStorage.isAsyncEncryptionAvailable()) &&
      !(platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"));
  return {
    available,
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
  };
}

/** What a sealed file is to its users: read, written, and forgotten. */
export interface Kept<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): void;
}

export class SealedFile<T> implements Kept<T> {
  /** The value where it cannot be written down. */
  private held: T | null = null;

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
    private readonly schema: z.ZodType<T, unknown>,
  ) {}

  /** Throws KeychainLockedError while the keychain is locked, which is not the file missing. */
  async load(): Promise<T | null> {
    if (this.held) return this.held;
    if (!this.box.available || !existsSync(this.file)) return null;
    try {
      const text = await this.box.decrypt(readFileSync(this.file));
      return this.schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof KeychainLockedError) throw error;
      // Sealed by another user or machine, or damaged: as good as none.
      return null;
    }
  }

  async save(value: T): Promise<void> {
    if (!this.box.available) {
      this.held = value;
      return;
    }
    const sealed = await this.box.encrypt(JSON.stringify(value));
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, sealed, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  clear(): void {
    this.held = null;
    rmSync(this.file, { force: true });
  }
}

/** A sealed file's stand-in in memory, for tests. */
export function keptInMemory<T>(initial: T | null = null): Kept<T> & { readonly value: T | null } {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
    get value() {
      return value;
    },
  };
}
