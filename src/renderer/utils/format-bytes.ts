/** A byte count for people: "512 B", "3.4 KB", "87 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // Rounded before the unit is picked: 1,048,575 bytes is "1.0 MB", not "1024 KB".
  const kb = rounded(bytes / 1024);
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = rounded(bytes / 1024 / 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/** A size as shown: whole from 10 up, else to one decimal. */
function rounded(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}
