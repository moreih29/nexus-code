const PROBE_STRING = "mmmmmmmmmmlli01234ABCabc";
const PROBE_SIZE = "72px";
const EPSILON = 0.5;

export function checkFontAvailable(family: string): boolean {
  if (typeof document === "undefined") return false;
  if (!family.trim()) return false;

  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;

  const [baselineMono, baselineSans] = widthsOf(ctx, "");
  const [testMono, testSans] = widthsOf(ctx, `"${family}"`);
  return Math.abs(testMono - baselineMono) > EPSILON || Math.abs(testSans - baselineSans) > EPSILON;
}

export type ProbeWidths = readonly [mono: number, sans: number];

function widthsOf(ctx: CanvasRenderingContext2D, family: string): ProbeWidths {
  const behind = family ? `${family}, ` : "";
  ctx.font = `${PROBE_SIZE} ${behind}monospace`;
  const mono = ctx.measureText(PROBE_STRING).width;
  ctx.font = `${PROBE_SIZE} ${behind}sans-serif`;
  return [mono, ctx.measureText(PROBE_STRING).width];
}

export function drawnAlike(a: ProbeWidths, b: ProbeWidths): boolean {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

export function drawnAsTimes(family: string): boolean {
  if (typeof document === "undefined") return false;
  if (family.trim().toLowerCase() === "times") return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  return drawnAlike(widthsOf(ctx, `"${family}"`), widthsOf(ctx, "Times"));
}
