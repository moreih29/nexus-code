// src/renderer/services/editor/runtime/local-fonts.ts
//
// The font families installed on this machine, as the settings' font fields
// offer them. Chromium lists them (Local Font Access); the first read takes
// most of a second, so it is made once, when a field first wants it, and
// kept. Null where the list cannot be had: the field then takes any name.

interface LocalFont {
  family: string;
}

type QueryLocalFonts = () => Promise<readonly LocalFont[]>;

let reading: Promise<readonly string[] | null> | null = null;

/** The installed families, each once, in order; null when they cannot be listed. */
export function localFontFamilies(): Promise<readonly string[] | null> {
  reading ??= readFamilies().then((families) => {
    // A failed read is tried again the next time.
    if (families === null) reading = null;
    return families;
  });
  return reading;
}

async function readFamilies(): Promise<readonly string[] | null> {
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof query !== "function") return null;
  try {
    const fonts = await query.call(globalThis);
    return uniqueFamilies(fonts.map((font) => font.family));
  } catch {
    return null;
  }
}

/** Each family once, as people read them in order. Pure. */
export function uniqueFamilies(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const family = name.trim();
    if (family === "" || seen.has(family)) continue;
    seen.add(family);
    out.push(family);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * The families that match `query`, best first: the name itself, then names
 * that start with it, then names with a word that starts with it, then any
 * that hold it; each group in the families' order. Case and the spaces
 * around it are ignored; an empty query matches all. Pure.
 */
export function matchFamilies(families: readonly string[], query: string): string[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [...families];
  const groups: string[][] = [[], [], [], []];
  for (const family of families) {
    const name = family.toLowerCase();
    const at = name.indexOf(wanted);
    if (at < 0) continue;
    if (name === wanted) groups[0].push(family);
    else if (at === 0) groups[1].push(family);
    else if (name.split(/[\s_-]+/).some((word) => word.startsWith(wanted))) groups[2].push(family);
    else groups[3].push(family);
  }
  return groups.flat();
}

/** The family `name` names, whatever its case; undefined when none does. Pure. */
export function familyNamed(families: readonly string[], name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  return wanted === "" ? undefined : families.find((family) => family.toLowerCase() === wanted);
}
