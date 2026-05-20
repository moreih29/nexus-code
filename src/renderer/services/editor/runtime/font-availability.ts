// src/renderer/services/editor/runtime/font-availability.ts
//
// Reliable font detection via canvas-width comparison.
//
// Why not `document.fonts.check()`? Chromium's FontFaceSet only reliably
// tracks fonts declared via `@font-face`. For OS-installed fonts (the typical
// "Fira Code", "D2 Coding", etc. that users type into the custom-family
// field), `document.fonts.check()` returns false-positives — yes for fonts
// that are not actually present. The Settings dialog then said "Current:
// D2 Coding" while the preview silently fell back to ui-monospace.
//
// Canvas measurement is the cross-browser technique used by font-faceobserver
// et al: render the same probe string with the target font (primary) +
// generic fallback (secondary), and with the generic fallback alone. If the
// target font is actually installed, the two widths differ. If not, the
// browser uses the fallback in both cases and the widths match exactly.
//
// We probe against TWO generic fallbacks (monospace + sans-serif) to handle
// the rare case where the target font's metrics happen to coincide with one
// fallback's metrics. A real difference in either probe is enough to call
// the font available.

const PROBE_STRING = "mmmmmmmmmmlli01234ABCabc";
const PROBE_SIZE = "72px"; // larger → bigger absolute width diff → less noise
const EPSILON = 0.5;

/**
 * Returns true when the font family `family` is actually rendered (not
 * silently falling back) in the current document.
 *
 * @param family  The font-family name to check, without quotes.
 * @example
 * ```ts
 * if (checkFontAvailable("JetBrains Mono Nerd Font")) {
 *   // font is ready to render
 * }
 * ```
 */
export function checkFontAvailable(family: string): boolean {
  if (typeof document === "undefined") return false;
  if (!family.trim()) return false;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  // Baseline widths: generic fallback alone.
  ctx.font = `${PROBE_SIZE} monospace`;
  const baselineMono = ctx.measureText(PROBE_STRING).width;
  ctx.font = `${PROBE_SIZE} sans-serif`;
  const baselineSans = ctx.measureText(PROBE_STRING).width;

  // Test widths: target font first, generic fallback after.
  ctx.font = `${PROBE_SIZE} "${family}", monospace`;
  const testMono = ctx.measureText(PROBE_STRING).width;
  ctx.font = `${PROBE_SIZE} "${family}", sans-serif`;
  const testSans = ctx.measureText(PROBE_STRING).width;

  // If the target font is installed and applied, at least one measurement
  // differs from its baseline. If both match, the browser fell back to the
  // generic both times → target font is not available.
  return (
    Math.abs(testMono - baselineMono) > EPSILON ||
    Math.abs(testSans - baselineSans) > EPSILON
  );
}
