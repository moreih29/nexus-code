export function distinctParents(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of unique) {
    const alreadyCovered = out.some((parent) => p === parent || p.startsWith(`${parent}/`));
    if (!alreadyCovered) out.push(p);
  }
  return out;
}
