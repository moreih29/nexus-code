/**
 * What a terminal program asks to put on the clipboard (OSC 52, iTerm2's
 * OSC 1337 Copy): base64 of UTF-8 text. Output can carry the sequence too
 * (a file shown with cat, a page fetched), so the controller takes it only
 * while the user's keys go to that terminal, and only up to
 * MAX_CLIPBOARD_CHARS: what a program the user works in copies, not
 * whatever scrolls past in another tab.
 */

/** The most text a terminal program may put on the clipboard at once. */
export const MAX_CLIPBOARD_CHARS = 1_000_000;

/**
 * The text a payload carries; null for one that is not base64, decodes to
 * more than MAX_CLIPBOARD_CHARS, or carries nothing.
 */
export function clipboardTextOf(base64: string): string | null {
  // Not decoded at all past what MAX_CLIPBOARD_CHARS could take: up to 4
  // UTF-8 bytes a character, 4 base64 characters to 3 bytes.
  if (base64 === "" || base64.length > MAX_CLIPBOARD_CHARS * 6) return null;
  try {
    // atob gives a Latin-1 character a byte; the payload is UTF-8, so decode it as such
    // ("저" EC A0 80 would be "ì \x80" otherwise).
    const bin = atob(base64);
    const text = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    if (text === "" || text.length > MAX_CLIPBOARD_CHARS) return null;
    return text;
  } catch {
    // Not base64: a malformed sequence, not worth telling the user of.
    return null;
  }
}
