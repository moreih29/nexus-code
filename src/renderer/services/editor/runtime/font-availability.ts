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

  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;

  // Baseline widths: generic fallback alone. Test widths: target font first,
  // generic fallback after. If the target font is installed and applied, at
  // least one measurement differs from its baseline. If both match, the
  // browser fell back to the generic both times → target font is not
  // available.
  const [baselineMono, baselineSans] = widthsOf(ctx, "");
  const [testMono, testSans] = widthsOf(ctx, `"${family}"`);
  return Math.abs(testMono - baselineMono) > EPSILON || Math.abs(testSans - baselineSans) > EPSILON;
}

/** The probe's widths in a font, with monospace and then sans-serif behind it. */
export type ProbeWidths = readonly [mono: number, sans: number];

function widthsOf(ctx: CanvasRenderingContext2D, family: string): ProbeWidths {
  const behind = family ? `${family}, ` : "";
  ctx.font = `${PROBE_SIZE} ${behind}monospace`;
  const mono = ctx.measureText(PROBE_STRING).width;
  ctx.font = `${PROBE_SIZE} ${behind}sans-serif`;
  return [mono, ctx.measureText(PROBE_STRING).width];
}

/** Whether two fonts draw the probe alike, with either fallback behind them. */
export function drawnAlike(a: ProbeWidths, b: ProbeWidths): boolean {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

/**
 * Whether the browser draws Times for `family`. Chrome on macOS does for a
 * name the system half knows, such as Apple SD Gothic Neo's Korean name
 * ("Apple SD 산돌고딕 Neo"): {@link checkFontAvailable} then finds a font
 * drawn, though not the one named. Times is not told apart from a font
 * drawn alike (Times New Roman, on macOS), so ask this only of a name the
 * installed fonts' list does not have.
 */
export function drawnAsTimes(family: string): boolean {
  if (typeof document === "undefined") return false;
  if (family.trim().toLowerCase() === "times") return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  return drawnAlike(widthsOf(ctx, `"${family}"`), widthsOf(ctx, "Times"));
}
