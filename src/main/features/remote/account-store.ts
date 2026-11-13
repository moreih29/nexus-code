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
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** The system's keychain, through Electron. */
export async function electronSecretBox(): Promise<SecretBox> {
  const { safeStorage } = await import("electron");
  return {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
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

  load(): SavedAccount | null {
    if (this.held) return this.held;
    if (!this.box.available() || !existsSync(this.file)) return null;
    try {
      return SavedAccountSchema.parse(JSON.parse(this.box.decrypt(readFileSync(this.file))));
    } catch {
      // Sealed by another user or machine, or damaged: as good as signed out.
      return null;
    }
  }

  save(account: SavedAccount): void {
    if (!this.box.available()) {
      this.held = account;
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.box.encrypt(JSON.stringify(account)), { mode: 0o600 });
  }

  clear(): void {
    this.held = null;
    rmSync(this.file, { force: true });
  }
}
