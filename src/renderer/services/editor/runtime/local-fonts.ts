// src/renderer/services/editor/runtime/local-fonts.ts
//
// The font families installed on this machine, as the settings' font fields
// offer them. Chromium lists them (Local Font Access); the first read takes
// most of a second, so it is made once, when a field first wants it, and
// kept. Null where the list cannot be had: the field then takes any name.
//
// Chromium lists a family by its English name only; the other names a font
// goes by (맑은 고딕 for Malgun Gothic) main reads from the system
// (system.fontNames), and a family is found by any of them.

import { ipcCallResult } from "../../../ipc/client";

interface LocalFont {
  family: string;
}

type QueryLocalFonts = () => Promise<readonly LocalFont[]>;

/** A family's other names, by the family as listed. */
export type FontAliases = ReadonlyMap<string, readonly string[]>;

const NO_ALIASES: FontAliases = new Map();

let reading: Promise<readonly string[] | null> | null = null;
let naming: Promise<readonly (readonly string[])[]> | null = null;

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

/** The families that go by more than one name, each as its names; none where the system cannot say. */
export function localFontNames(): Promise<readonly (readonly string[])[]> {
  naming ??= ipcCallResult("system", "fontNames", undefined).then(
    (result) => (result.ok ? result.value.groups : []),
    () => [],
  );
  return naming;
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
 * The other names of the families listed, from `groups`, each a family's
 * names: those of a group that are not listed themselves, by the listed ones,
 * whatever their case. Pure.
 */
export function fontAliases(
  families: readonly string[],
  groups: readonly (readonly string[])[],
): FontAliases {
  const listed = new Map(families.map((family) => [family.toLowerCase(), family]));
  const aliases = new Map<string, string[]>();
  for (const names of groups) {
    const others = names.filter((name) => !listed.has(name.toLowerCase()));
    if (others.length === 0) continue;
    for (const name of names) {
      const family = listed.get(name.toLowerCase());
      if (family === undefined) continue;
      const had = aliases.get(family) ?? [];
      const fresh = others.filter((o) => !had.some((h) => h.toLowerCase() === o.toLowerCase()));
      aliases.set(family, [...had, ...fresh]);
    }
  }
  return aliases;
}

/**
 * The families that match `query`, by their name or another (`aliases`),
 * best first: the name itself, then names that start with it, then names
 * with a word that starts with it, then any that hold it; each group in the
 * families' order. Case and the spaces around it are ignored; an empty query
 * matches all. Pure.
 */
export function matchFamilies(
  families: readonly string[],
  query: string,
  aliases: FontAliases = NO_ALIASES,
): string[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [...families];
  const groups: string[][] = [[], [], [], []];
  for (const family of families) {
    let best = -1;
    for (const name of [family, ...(aliases.get(family) ?? [])]) {
      const rank = matchRank(name.toLowerCase(), wanted);
      if (rank >= 0 && (best < 0 || rank < best)) best = rank;
    }
    if (best >= 0) groups[best]?.push(family);
  }
  return groups.flat();
}

/** 0 for the name itself, 1 a start, 2 a word's start, 3 within; -1 for none. */
function matchRank(name: string, wanted: string): number {
  const at = name.indexOf(wanted);
  if (at < 0) return -1;
  if (name === wanted) return 0;
  if (at === 0) return 1;
  if (name.split(/[\s_-]+/).some((word) => word.startsWith(wanted))) return 2;
  return 3;
}

/**
 * The family `name` names, by its name or another (`aliases`), whatever its
 * case; undefined when none does. Pure.
 */
export function familyNamed(
  families: readonly string[],
  name: string,
  aliases: FontAliases = NO_ALIASES,
): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return undefined;
  return (
    families.find((family) => family.toLowerCase() === wanted) ??
    families.find((family) => aliases.get(family)?.some((alias) => alias.toLowerCase() === wanted))
  );
}
