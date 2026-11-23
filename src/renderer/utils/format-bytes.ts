const KIB = 1024;

export function formatBytes(bytes: number, style: "compact" | "notes" = "compact"): string {
  if (bytes < KIB) return `${bytes} B`;
  const compact = style === "compact";
  const kb = bytes / KIB;
  const displayKb = compact ? rounded(kb) : kb;
  if (displayKb < KIB) return `${displayKb.toFixed(displayKb >= 10 ? 0 : 1)} KB`;

  const mb = kb / KIB;
  if (!compact && !(mb < KIB)) return `${(mb / KIB).toFixed(1)} GB`;
  const displayMb = compact ? rounded(mb) : mb;
  return `${displayMb.toFixed(compact && displayMb >= 10 ? 0 : 1)} MB`;
}

function rounded(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}
