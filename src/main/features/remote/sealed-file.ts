import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

export class KeychainLockedError extends Error {
  constructor() {
    super("The keychain is locked");
    this.name = "KeychainLockedError";
  }
}

export interface SecretBox {
  readonly available: boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

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

export interface Kept<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): void;
}

export class SealedFile<T> implements Kept<T> {
  private held: T | null = null;

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
    private readonly schema: z.ZodType<T, unknown>,
  ) {}

  async load(): Promise<T | null> {
    if (this.held) return this.held;
    if (!this.box.available || !existsSync(this.file)) return null;
    try {
      const text = await this.box.decrypt(readFileSync(this.file));
      return this.schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof KeychainLockedError) throw error;
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
