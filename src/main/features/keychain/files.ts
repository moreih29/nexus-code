// The app's own files sealed with the keychain, under userData.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_ITEMS, type KeychainItem } from "../../../shared/keychain";

/** The sealed files, by name. */
export const SEALED_FILES = {
  remoteAccount: "remote-account.bin",
  remoteKey: "remote-key.bin",
  profileKeys: "profile-api-keys.bin",
  voices: "remembered-voices.bin",
} as const;

const ITEM_FILES: Record<KeychainItem, readonly string[]> = {
  remote: [SEALED_FILES.remoteAccount, SEALED_FILES.remoteKey],
  profileKeys: [SEALED_FILES.profileKeys],
  voices: [SEALED_FILES.voices],
};

/** The items with a sealed file in the folder now. */
export function sealedItems(userData: string): KeychainItem[] {
  return KEYCHAIN_ITEMS.filter((item) =>
    ITEM_FILES[item].some((name) => existsSync(join(userData, name))),
  );
}
