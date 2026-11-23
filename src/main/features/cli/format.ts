export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

export function ago(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function clockAt(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = at - now >= 24 * 3_600_000 ? `${date.getMonth() + 1}/${date.getDate()} ` : "";
  const minutes = Math.round((at - now) / 60_000);
  const off =
    minutes <= 0
      ? "now"
      : minutes < 60
        ? `in ${minutes}m`
        : minutes < 48 * 60
          ? `in ${Math.round(minutes / 60)}h`
          : `in ${Math.round(minutes / 1440)}d`;
  return `${day}${pad(date.getHours())}:${pad(date.getMinutes())} (${off})`;
}

export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
