import { ipcCallResult } from "../../../ipc/client";

interface LocalFont {
  family: string;
}

type QueryLocalFonts = () => Promise<readonly LocalFont[]>;

export type FontAliases = ReadonlyMap<string, readonly string[]>;

const NO_ALIASES: FontAliases = new Map();

let reading: Promise<readonly string[] | null> | null = null;
let naming: Promise<readonly (readonly string[])[]> | null = null;

export function localFontFamilies(): Promise<readonly string[] | null> {
  reading ??= readFamilies().then((families) => {
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

export function localFontNames(): Promise<readonly (readonly string[])[]> {
  naming ??= ipcCallResult("system", "fontNames", undefined).then(
    (result) => (result.ok ? result.value.groups : []),
    () => [],
  );
  return naming;
}

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

function matchRank(name: string, wanted: string): number {
  const at = name.indexOf(wanted);
  if (at < 0) return -1;
  if (name === wanted) return 0;
  if (at === 0) return 1;
  if (name.split(/[\s_-]+/).some((word) => word.startsWith(wanted))) return 2;
  return 3;
}

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
