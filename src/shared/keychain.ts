import { z } from "zod";

export const KEYCHAIN_ITEMS = ["remote", "profileKeys", "voices"] as const;
export const KeychainItemSchema = z.enum(KEYCHAIN_ITEMS);
export type KeychainItem = z.infer<typeof KeychainItemSchema>;

export const KeychainStatusSchema = z.object({
  state: z.enum(["checking", "ask", "opening", "open", "locked"]),
  items: z.array(KeychainItemSchema),
  busy: z.boolean(),
  refused: z.boolean(),
});
export type KeychainStatus = z.infer<typeof KeychainStatusSchema>;

export function keychainLocked(status: KeychainStatus | null, item: KeychainItem): boolean {
  return (
    status !== null &&
    (status.state === "ask" || status.state === "opening" || status.state === "locked") &&
    status.items.includes(item)
  );
}
