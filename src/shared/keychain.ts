// The macOS keychain the app seals its own files with (main/features/keychain).

import { z } from "zod";

/** What the app keeps sealed: the remote's sign-in and key, the profiles' API keys, the remembered voices. */
export const KEYCHAIN_ITEMS = ["remote", "profileKeys", "voices"] as const;
export const KeychainItemSchema = z.enum(KEYCHAIN_ITEMS);
export type KeychainItem = z.infer<typeof KeychainItemSchema>;

export const KeychainStatusSchema = z.object({
  /**
   * checking: finding out whether to ask first; ask: waiting for the user's
   * answer before reading; opening: reading what waited; open: reads go
   * ahead; locked: put off for this run, or refused in macOS's prompt.
   * Away from macOS it is always open.
   */
  state: z.enum(["checking", "ask", "opening", "open", "locked"]),
  /** The sealed files there are, by what they keep. */
  items: z.array(KeychainItemSchema),
  /** A keychain call has run past the time macOS takes to answer by itself: it is asking. */
  busy: z.boolean(),
});
export type KeychainStatus = z.infer<typeof KeychainStatusSchema>;

/** Whether what the item keeps waits on the keychain: not read yet, and shown as locked. */
export function keychainLocked(status: KeychainStatus | null, item: KeychainItem): boolean {
  return (
    status !== null &&
    (status.state === "ask" || status.state === "opening" || status.state === "locked") &&
    status.items.includes(item)
  );
}
