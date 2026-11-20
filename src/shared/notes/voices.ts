/**
 * Who said each line of a recording, by voice print: each line long enough
 * is heard as a vector (the voice print model's, unit length), and lines
 * whose vectors are alike are one voice. The server's own speaker labels mix
 * people up (two men on one call come out as one), so a recording with voice
 * prints keys its voices by these instead: "1", "2", … for the whole
 * recording, the same across its takes.
 *
 * A line is given a voice as it comes (the nearest one, or a new one), and
 * every so often all the lines heard so far are grouped again, which is
 * steadier than one at a time: average-linkage clustering, keeping what the
 * user said. A line the user moved to a voice stays with it ("pinned"), and
 * pinned lines of different people are never grouped together; voices given
 * one name are one person. The groups keep the keys their lines had, so
 * names stay where they were.
 *
 * Pure: no IO here.
 */

/** Lines this long or longer make the groups; shorter ones join the nearest. */
export const GROUP_MIN_MS = 2500;
/** Groups this alike (average cosine) are one voice. */
export const SAME_VOICE = 0.6;
/** A line as it comes joins the nearest voice this alike, else it starts a new one. */
export const LIVE_MATCH = 0.5;
/** A short line joins the nearest voice only when it is this alike. */
export const SHORT_MATCH = 0.35;
/** A line as it comes starts a new voice only when it is this long, to tell it by. */
export const NEW_VOICE_MS = 3000;
/** A group of fewer lines than this (none of them pinned) joins the nearest group alike enough. */
export const SMALL_GROUP = 4;
/** How alike a small group must be to join another. */
export const SMALL_MATCH = 0.3;
/** The anchor and live thresholds when the participant count is known. */
export const COUNTED_GROUP_MIN_MS = 2000;
const COUNTED_LIVE_MATCH = 0.45;
const COUNTED_NEW_VOICE_MS = 2200;

export interface VoiceLine {
  /** The line's start in the recording (ms): which line it is. */
  at: number;
  /** How long the line is (ms). */
  ms: number;
  /** The voice the line has now. */
  key: string;
  /** The user moved the line to its voice. */
  pinned?: boolean;
}

/** A line with a voice print. */
export interface VoiceSample extends VoiceLine {
  vector: ArrayLike<number>;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function addInto(into: Float64Array, v: ArrayLike<number>): void {
  for (let i = 0; i < into.length; i++) into[i] = (into[i] as number) + (v[i] as number);
}

/** The next key not taken: "1", "2", … */
export function nextVoiceKey(taken: Iterable<string>): string {
  const keys = new Set(taken);
  let n = 1;
  while (keys.has(String(n))) n++;
  return String(n);
}

/** A voice's person: its name, or the voice itself when it has none. */
export function voicePerson(names: Readonly<Record<string, string>>, key: string): string {
  const name = names[key]?.trim();
  return name ? `name:${name}` : `voice:${key}`;
}

/** The voices' lines' vectors added up, and how many, by key: what a line as it comes is matched against. */
export function voiceSums(
  samples: readonly VoiceSample[],
  groupMinMs = GROUP_MIN_MS,
): Map<string, { sum: Float64Array; count: number }> {
  const out = new Map<string, { sum: Float64Array; count: number }>();
  for (const s of samples) {
    if (s.ms < groupMinMs && !s.pinned) continue;
    let v = out.get(s.key);
    if (!v) {
      v = { sum: new Float64Array(s.vector.length), count: 0 };
      out.set(s.key, v);
    }
    addInto(v.sum, s.vector);
    v.count += 1;
  }
  return out;
}

/** The voice nearest to `vector` among `sums`, and how alike (average cosine with its lines). */
export function nearestVoice(
  sums: ReadonlyMap<string, { sum: ArrayLike<number>; count: number }>,
  vector: ArrayLike<number>,
): { key: string; similarity: number } | null {
  let best: { key: string; similarity: number } | null = null;
  for (const [key, { sum, count }] of sums) {
    if (!count) continue;
    const similarity = dot(sum, vector) / count;
    if (!best || similarity > best.similarity) best = { key, similarity };
  }
  return best;
}

/**
 * The voice for a line as it comes: the nearest when alike enough; else a
 * new one when the line is long enough to tell; else `fallback` (the voice
 * its server label last went with, or the line before's).
 */
export function liveVoice(
  sums: ReadonlyMap<string, { sum: ArrayLike<number>; count: number }>,
  sample: { vector: ArrayLike<number> | null; ms: number },
  taken: Iterable<string>,
  fallback: string | null,
  target?: number,
  names: Readonly<Record<string, string>> = {},
): string {
  const near = sample.vector ? nearestVoice(sums, sample.vector) : null;
  const counted = target !== undefined;
  const keys = new Set(taken);
  if (counted && new Set([...keys].map((key) => voicePerson(names, key))).size >= target) {
    return near?.key ?? fallback ?? keys.values().next().value ?? nextVoiceKey(keys);
  }
  if (near && near.similarity >= (counted ? COUNTED_LIVE_MATCH : LIVE_MATCH)) return near.key;
  if (!near && fallback) return fallback;
  if (sample.vector && sample.ms >= (counted ? COUNTED_NEW_VOICE_MS : NEW_VOICE_MS))
    return nextVoiceKey(keys);
  if (near && near.similarity >= SHORT_MATCH) return near.key;
  return fallback ?? (counted ? near?.key : null) ?? nextVoiceKey(keys);
}

interface Cluster {
  /** The samples in it, by index. */
  members: number[];
  /** Weight: how many lines it stands for. */
  weight: number;
  /** The person its pinned lines are of, if any. */
  pinned: string | null;
  alive: boolean;
}

/**
 * All of a recording's voices grouped again: the voice of each sample, by
 * `at`. Keys stay with the groups that had most of their lines, so a group
 * that was one voice keeps its key and its name; a group with none takes the
 * person its moved (pinned) lines were moved to, or a new key. Moved lines
 * keep their voice, and lines moved to different people are never grouped.
 */
export function regroupVoices(input: {
  samples: readonly VoiceSample[];
  names: Readonly<Record<string, string>>;
  sameVoice?: number;
  /** The full set of assigned lines, including those without a voice print. */
  lines?: readonly VoiceLine[];
  target?: number;
}): Map<number, string> {
  const { samples, names } = input;
  const threshold = input.sameVoice ?? SAME_VOICE;
  const counted = input.target !== undefined;
  const lines = input.lines ?? samples;
  const protectedKeys = new Map<string, string>();
  for (const line of lines) {
    if (!line.pinned && !names[line.key]?.trim()) continue;
    const person = voicePerson(names, line.key);
    if (!protectedKeys.has(person)) protectedKeys.set(person, line.key);
  }
  const limit = Math.max(input.target ?? 0, protectedKeys.size);
  const protectedPerson = (line: VoiceLine) =>
    line.pinned || names[line.key]?.trim() ? voicePerson(names, line.key) : null;
  const minMs = counted ? COUNTED_GROUP_MIN_MS : GROUP_MIN_MS;
  const useShortAnchors = counted && !samples.some((s) => s.ms >= minMs);
  // The units grouped: each long sample, and the pinned lines of one person together.
  const units: {
    vectorSum: Float64Array;
    count: number;
    members: number[];
    pinned: string | null;
  }[] = [];
  const byPerson = new Map<string, number>();
  const dims = samples[0]?.vector.length ?? 0;
  const unitOf = (pinned: string | null) => {
    if (pinned !== null) {
      const have = byPerson.get(pinned);
      if (have !== undefined) return units[have] as (typeof units)[number];
    }
    const unit = { vectorSum: new Float64Array(dims), count: 0, members: [] as number[], pinned };
    units.push(unit);
    if (pinned !== null) byPerson.set(pinned, units.length - 1);
    return unit;
  };
  const short: number[] = [];
  samples.forEach((s, i) => {
    const person = protectedPerson(s);
    if (person === null && s.ms < minMs && !useShortAnchors) {
      short.push(i);
      return;
    }
    const unit = unitOf(person);
    addInto(unit.vectorSum, s.vector);
    unit.count += 1;
    unit.members.push(i);
  });
  // A protected voice without a print still takes a place in the count.
  if (counted) for (const person of protectedKeys.keys()) unitOf(person);

  // Average linkage over the units: the similarity of two groups is the mean
  // cosine of their lines', which their summed vectors give (sumA·sumB / nA·nB).
  const n = units.length;
  const clusters: Cluster[] = units.map((u) => ({
    members: u.members,
    weight: u.count,
    pinned: u.pinned,
    alive: true,
  }));
  const sums = units.map((u) => u.vectorSum);
  const sim = new Float64Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const weight = (clusters[a] as Cluster).weight * (clusters[b] as Cluster).weight;
      const v = weight ? dot(sums[a] as Float64Array, sums[b] as Float64Array) / weight : -1;
      sim[a * n + b] = v;
      sim[b * n + a] = v;
    }
  }
  const apart = (a: Cluster, b: Cluster) =>
    a.pinned !== null && b.pinned !== null && a.pinned !== b.pinned;
  // Each cluster's most alike partner, kept up to date as clusters merge.
  const best = new Int32Array(n).fill(-1);
  const bestSim = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
  const findBest = (a: number) => {
    best[a] = -1;
    bestSim[a] = Number.NEGATIVE_INFINITY;
    const ca = clusters[a] as Cluster;
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const cb = clusters[b] as Cluster;
      if (!cb.alive || apart(ca, cb)) continue;
      const v = sim[a * n + b] as number;
      if (v > (bestSim[a] as number)) {
        bestSim[a] = v;
        best[a] = b;
      }
    }
  };
  for (let a = 0; a < n; a++) findBest(a);
  for (let remaining = n; !counted || remaining > limit; remaining--) {
    let a = -1;
    for (let i = 0; i < n; i++) {
      if (
        (clusters[i] as Cluster).alive &&
        best[i] !== -1 &&
        (a === -1 || (bestSim[i] as number) > (bestSim[a] as number))
      )
        a = i;
    }
    if (a === -1 || (!counted && (bestSim[a] as number) < threshold)) break;
    const b = best[a] as number;
    const ca = clusters[a] as Cluster;
    const cb = clusters[b] as Cluster;
    // b into a.
    for (let c = 0; c < n; c++) {
      if (c === a || c === b || !(clusters[c] as Cluster).alive) continue;
      const weight = ca.weight + cb.weight;
      const v = weight
        ? ((sim[a * n + c] as number) * ca.weight + (sim[b * n + c] as number) * cb.weight) / weight
        : -1;
      sim[a * n + c] = v;
      sim[c * n + a] = v;
    }
    ca.members.push(...cb.members);
    ca.weight += cb.weight;
    ca.pinned ??= cb.pinned;
    addInto(sums[a] as Float64Array, sums[b] as Float64Array);
    cb.alive = false;
    for (let c = 0; c < n; c++) {
      const cc = clusters[c] as Cluster;
      if (!cc.alive) continue;
      if (c === a || best[c] === a || best[c] === b) findBest(c);
      else if (!apart(cc, ca) && (sim[c * n + a] as number) > (bestSim[c] as number)) {
        bestSim[c] = sim[c * n + a] as number;
        best[c] = a;
      }
    }
  }
  const groups = clusters
    .map((c, i) => ({ ...c, sum: sums[i] as Float64Array }))
    .filter((c) => c.alive);
  // A few lines alone are more likely a voice heard badly than a person: they join the
  // nearest group when alike enough, smallest first.
  const small = (g: (typeof groups)[number]) => g.pinned === null && g.members.length < SMALL_GROUP;
  for (const g of counted ? [] : [...groups].sort((x, y) => x.weight - y.weight)) {
    if (!g.alive || !small(g)) continue;
    let into: (typeof groups)[number] | null = null;
    let most = SMALL_MATCH;
    for (const h of groups) {
      if (h === g || !h.alive) continue;
      const v = dot(g.sum, h.sum) / (g.weight * h.weight);
      if (v >= most) {
        most = v;
        into = h;
      }
    }
    if (!into) continue;
    into.members.push(...g.members);
    into.weight += g.weight;
    addInto(into.sum, g.sum);
    g.alive = false;
  }
  for (let i = groups.length - 1; i >= 0; i--)
    if (!(groups[i] as (typeof groups)[number]).alive) groups.splice(i, 1);

  // Keys go to the groups that hold most of their lines. Lines the user moved don't vote:
  // moving one changes that line, not the voice of the lines around it.
  const votes: { group: number; key: string; weight: number }[] = [];
  groups.forEach((g, gi) => {
    const byKey = new Map<string, number>();
    for (const m of g.members) {
      const s = samples[m] as VoiceSample;
      if (!s.pinned) byKey.set(s.key, (byKey.get(s.key) ?? 0) + 1);
    }
    for (const [key, weight] of byKey) votes.push({ group: gi, key, weight });
  });
  votes.sort((x, y) => y.weight - x.weight);
  const keyOfGroup = new Map<number, string>();
  const namedKeys = Object.keys(names).filter((key) => names[key]?.trim());
  const used = new Set(namedKeys);
  if (counted) {
    for (const line of lines) if (line.pinned) used.add(line.key);
  }
  groups.forEach((g, gi) => {
    if (g.pinned === null || (!counted && !g.pinned.startsWith("name:"))) return;
    const key = protectedKeys.get(g.pinned);
    if (key !== undefined) keyOfGroup.set(gi, key);
  });
  for (const v of votes) {
    if (keyOfGroup.has(v.group) || used.has(v.key)) continue;
    keyOfGroup.set(v.group, v.key);
    used.add(v.key);
  }
  // A group left without one goes with the person its moved lines were moved to, or is new.
  const taken = new Set([...lines.map((s) => s.key), ...Object.keys(names)]);
  groups.forEach((g, gi) => {
    if (keyOfGroup.has(gi)) return;
    const moved = new Map<string, number>();
    for (const m of g.members) {
      const s = samples[m] as VoiceSample;
      if (s.pinned) moved.set(s.key, (moved.get(s.key) ?? 0) + 1);
    }
    let key: string | null = null;
    let most = 0;
    for (const [k, n] of moved) {
      if (n > most) {
        most = n;
        key = k;
      }
    }
    if (key === null) {
      key = nextVoiceKey(taken);
      taken.add(key);
    }
    keyOfGroup.set(gi, key);
  });

  const keys = new Map<number, string>();
  groups.forEach((g, gi) => {
    const key = keyOfGroup.get(gi) as string;
    for (const m of g.members) keys.set((samples[m] as VoiceSample).at, key);
  });
  // Pinned lines keep their voice whatever their group's key.
  for (const s of lines) if (protectedPerson(s) !== null) keys.set(s.at, s.key);
  // Short lines join the nearest group when alike enough; else they keep their voice.
  for (const i of short) {
    const s = samples[i] as VoiceSample;
    let bestKey: string | null = null;
    let most = counted ? Number.NEGATIVE_INFINITY : SHORT_MATCH;
    groups.forEach((g, gi) => {
      if (!g.weight) return;
      const v = dot(g.sum, s.vector) / g.weight;
      if (v >= most) {
        most = v;
        bestKey = keyOfGroup.get(gi) as string;
      }
    });
    keys.set(s.at, bestKey ?? s.key);
  }
  if (counted) {
    // Where there is no print, keep a supported assignment or follow the closest anchor in time.
    const anchors = groups.flatMap((g) => g.members.map((m) => samples[m] as VoiceSample));
    const supported = new Set([...keyOfGroup.values(), ...protectedKeys.values()]);
    const fallback = anchors[0]?.key ?? supported.values().next().value ?? lines[0]?.key;
    for (const line of lines) {
      if (keys.has(line.at) || supported.has(line.key)) continue;
      let nearest: string | undefined = fallback;
      let distance = Number.POSITIVE_INFINITY;
      const mid = line.at + line.ms / 2;
      for (const anchor of anchors) {
        const delta = Math.abs(mid - (anchor.at + anchor.ms / 2));
        if (delta >= distance) continue;
        distance = delta;
        nearest = keys.get(anchor.at);
      }
      if (nearest !== undefined) keys.set(line.at, nearest);
    }
  }
  return keys;
}
