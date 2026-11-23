export function toggleTaskMarker(line: string): string | null {
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line);
  if (!m) return null;
  const checked = m[2] !== " ";
  const replacement = checked ? "[ ]" : "[x]";
  const at = m[1].length;
  return line.slice(0, at) + replacement + line.slice(at + 3);
}
