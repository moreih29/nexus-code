export function heartbeatHistogramLine(
  intervalMs: number,
  histogram: readonly number[],
): string | null {
  const total = histogram.reduce((a, b) => a + b, 0);
  const late = total - (histogram[0] ?? 0);
  if (total === 0 || late === 0) return null;
  const last = histogram.length - 1;
  const buckets = histogram
    .map((n, i) => `[${i === last ? `${i}+` : `${i}-${i + 1}`}x]:${n}`)
    .join(" ");
  return `heartbeat late (interval=${intervalMs}ms, total=${total}, late=${late}): ${buckets}`;
}
