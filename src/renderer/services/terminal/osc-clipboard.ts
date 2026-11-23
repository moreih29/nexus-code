export const MAX_CLIPBOARD_CHARS = 1_000_000;

export function clipboardTextOf(base64: string): string | null {
  if (base64 === "" || base64.length > MAX_CLIPBOARD_CHARS * 6) return null;
  try {
    const bin = atob(base64);
    const text = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    if (text === "" || text.length > MAX_CLIPBOARD_CHARS) return null;
    return text;
  } catch {
    return null;
  }
}
