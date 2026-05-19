// src/renderer/services/editor/runtime/font-availability.ts
//
// Thin wrapper around document.fonts.check() for querying whether a named
// font family has been loaded by the browser/Electron renderer.
//
// SSR-safe: returns false when `window` is not available (e.g. during Vite
// SSR pre-render or unit tests that run in a bare Node environment without
// a DOM).

/**
 * Returns true when the font family `family` is available (loaded) in the
 * current document at a representative size.
 *
 * @param family  The font-family name to check, without quotes.
 *                e.g. `"JetBrains Mono Nerd Font"` or `"Cascadia Code"`.
 *
 * @example
 * ```ts
 * if (checkFontAvailable("JetBrains Mono Nerd Font")) {
 *   // font is ready
 * }
 * ```
 */
export function checkFontAvailable(family: string): boolean {
  if (typeof window === "undefined") return false;
  if (!document.fonts || typeof document.fonts.check !== "function") return false;
  try {
    // Use a representative size; the actual size does not affect availability
    // detection for most font formats.
    return document.fonts.check(`12px "${family}"`);
  } catch {
    return false;
  }
}
