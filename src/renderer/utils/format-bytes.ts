const KIB = 1024;

/**
 * Formats a byte count in binary units. Notes storage uses raw unit
 * thresholds and shows one decimal in MB or GB.
 */
export function formatBytes(bytes: number, style: "compact" | "notes" = "compact"): string {
  if (bytes < KIB) return `${bytes} B`;
  const compact = style === "compact";
  // Compact sizes pick the unit after rounding, avoiding displays like "1024 KB".
  const kb = bytes / KIB;
  const displayKb = compact ? rounded(kb) : kb;
  if (displayKb < KIB) return `${displayKb.toFixed(displayKb >= 10 ? 0 : 1)} KB`;

  const mb = kb / KIB;
  if (!compact && !(mb < KIB)) return `${(mb / KIB).toFixed(1)} GB`;
  const displayMb = compact ? rounded(mb) : mb;
  return `${displayMb.toFixed(compact && displayMb >= 10 ? 0 : 1)} MB`;
}

/** A size as shown: whole from 10 up, else to one decimal. */
function rounded(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}
