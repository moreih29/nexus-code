/**
 * A file of the app's own, sealed with the system's keychain (Electron
 * safeStorage): where the NexusCode sign-in and the account key are kept.
 * Where the system has none to seal with (Linux without a keyring), nothing
 * is written: what would be kept lasts until the app quits.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/** What seals and opens the file. */
export interface SecretBox {
  /** Whether it seals for real: false where it would write plain text. */
  readonly available: boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

/** The system's keychain, through Electron's asynchronous safeStorage. */
export async function electronSecretBox(): Promise<SecretBox> {
  const { safeStorage } = await import("electron");
  const available =
    (await safeStorage.isAsyncEncryptionAvailable()) &&
    !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
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
    private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ) {}

  async load(): Promise<T | null> {
    if (this.held) return this.held;
    if (!this.box.available || !existsSync(this.file)) return null;
    try {
      const text = await this.box.decrypt(readFileSync(this.file));
      return this.schema.parse(JSON.parse(text));
    } catch {
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
    writeFileSync(this.file, sealed, { mode: 0o600 });
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
