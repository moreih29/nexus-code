/**
 * Where the app keeps its NexusCode sign-in: in a file of its own, sealed
 * with the system's keychain (Electron safeStorage). Where the system has
 * none to seal with (Linux without a keyring), nothing is written: the
 * sign-in lasts until the app quits.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { RemoteDeviceInfoSchema, RemoteUserSchema } from "../../../shared/remote/account";

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

export const SavedAccountSchema = z.object({
  server: z.string(),
  token: z.string(),
  user: RemoteUserSchema,
  device: RemoteDeviceInfoSchema,
});
export type SavedAccount = z.infer<typeof SavedAccountSchema>;

export class AccountStore {
  /** The sign-in where it cannot be written down. */
  private held: SavedAccount | null = null;

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
  ) {}

  async load(): Promise<SavedAccount | null> {
    if (this.held) return this.held;
    if (!this.box.available || !existsSync(this.file)) return null;
    try {
      const text = await this.box.decrypt(readFileSync(this.file));
      return SavedAccountSchema.parse(JSON.parse(text));
    } catch {
      // Sealed by another user or machine, or damaged: as good as signed out.
      return null;
    }
  }

  async save(account: SavedAccount): Promise<void> {
    if (!this.box.available) {
      this.held = account;
      return;
    }
    const sealed = await this.box.encrypt(JSON.stringify(account));
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, sealed, { mode: 0o600 });
  }

  clear(): void {
    this.held = null;
    rmSync(this.file, { force: true });
  }
}
