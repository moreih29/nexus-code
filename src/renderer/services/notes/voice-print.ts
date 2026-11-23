import { useEffect, useState } from "react";
import {
  COUNTED_GROUP_MIN_MS,
  liveVoice,
  nextVoiceKey,
  regroupVoices,
  type VoiceLine,
  type VoiceSample,
  voiceSums,
} from "../../../shared/notes/voices";
import { MAX_VOICE_PRINT_SAMPLES } from "../../../shared/types/notes";
import { notesApi } from "./api";

export const VOICE_PRINT_RATE = 16_000;
const KEEP_SECONDS = 120;
export const REGROUP_MS = 15_000;
export const MIN_PRINT_MS = 400;

const PROBE_MS = 5000;

let availability: Promise<boolean> | undefined;

function probeVoicePrint(): Promise<boolean> {
  availability ??= notesApi.voicePrint(new Float32Array(VOICE_PRINT_RATE / 2)).then(
    (vector) => {
      if (vector !== null) return true;
      availability = undefined;
      return false;
    },
    () => {
      availability = undefined;
      return false;
    },
  );
  return availability;
}

export function voicePrintAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), PROBE_MS);
    void probeVoicePrint().then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export function useVoicePrintAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let mounted = true;
    void probeVoicePrint().then((value) => {
      if (mounted) setAvailable(value);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return available;
}

export interface HeardLine {
  at: number;
  endAt: number;
  startMs: number;
  endMs: number;
  label: string;
}

export class VoiceTracker {
  private readonly samples: VoiceSample[] = [];
  private readonly lines = new Map<number, VoiceLine>();
  private readonly pendingPins = new Map<number, string>();
  private readonly ring = new Float32Array(VOICE_PRINT_RATE * KEEP_SECONDS);
  private heard = 0;
  private readonly byLabel = new Map<string, string>();
  private last: string | null = null;
  private lastRegroup = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<number>();

  constructor(private readonly target?: number) {}

  startTake(): void {
    this.heard = 0;
    this.byLabel.clear();
  }

  hear(samples: Float32Array): void {
    const size = this.ring.length;
    let at = this.heard % size;
    let from = 0;
    while (from < samples.length) {
      const n = Math.min(samples.length - from, size - at);
      this.ring.set(samples.subarray(from, from + n), at);
      from += n;
      at = (at + n) % size;
    }
    this.heard += samples.length;
  }

  provisional(label: string, taken: Iterable<string>): string {
    return this.byLabel.get(label) ?? this.last ?? nextVoiceKey(taken);
  }

  undecided(at: number): boolean {
    return this.pending.has(at);
  }

  private audioOf(startMs: number, endMs: number): Float32Array | null {
    const size = this.ring.length;
    const start = Math.max(Math.floor((startMs * VOICE_PRINT_RATE) / 1000), this.heard - size, 0);
    const end = Math.min(
      Math.floor((endMs * VOICE_PRINT_RATE) / 1000),
      this.heard,
      start + MAX_VOICE_PRINT_SAMPLES,
    );
    if (end - start < (MIN_PRINT_MS * VOICE_PRINT_RATE) / 1000) return null;
    const out = new Float32Array(end - start);
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(start + i) % size] as number;
    return out;
  }

  lineHeard(
    line: HeardLine,
    taken: () => Iterable<string>,
    names: () => Readonly<Record<string, string>>,
  ): Promise<{ key: string; regrouped: Map<number, string> | null }> {
    const audio = this.audioOf(line.startMs, line.endMs);
    const ms = line.endAt - line.at;
    this.pending.add(line.at);
    const next = this.queue.then(async () => {
      const vector = audio ? await notesApi.voicePrint(audio).catch(() => null) : null;
      const pinned = this.pendingPins.get(line.at);
      const key =
        pinned ??
        liveVoice(
          voiceSums(this.samples, this.target === undefined ? undefined : COUNTED_GROUP_MIN_MS),
          { vector, ms },
          taken(),
          this.byLabel.get(line.label) ?? this.last,
          this.target,
          names(),
        );
      this.pending.delete(line.at);
      this.pendingPins.delete(line.at);
      this.byLabel.set(line.label, key);
      this.last = key;
      const heard = { at: line.at, ms, key, pinned: pinned !== undefined };
      if (vector) {
        const sample = { ...heard, vector };
        this.samples.push(sample);
        this.lines.set(line.at, sample);
      } else this.lines.set(line.at, heard);
      let regrouped: Map<number, string> | null = null;
      if (vector && line.endAt - this.lastRegroup >= REGROUP_MS) {
        regrouped = this.regroup(names());
        this.lastRegroup = line.endAt;
      }
      return { key: regrouped?.get(line.at) ?? key, regrouped };
    });
    this.queue = next.catch(() => {
      this.pending.delete(line.at);
      this.pendingPins.delete(line.at);
    });
    return next;
  }

  nameSamples(): readonly VoiceSample[] {
    return this.samples;
  }

  settled(): Promise<void> {
    return this.queue.then(() => {});
  }

  pin(
    ats: readonly number[],
    key: string,
    names: Readonly<Record<string, string>>,
    merged?: ReadonlySet<string>,
  ): Map<number, string> {
    for (const at of ats) {
      if (this.pending.has(at)) this.pendingPins.set(at, key);
      const line = this.lines.get(at);
      if (!line) continue;
      line.key = key;
      line.pinned = true;
    }
    if (merged?.size) {
      for (const [label, from] of this.byLabel) if (merged.has(from)) this.byLabel.set(label, key);
      if (this.last && merged.has(this.last)) this.last = key;
    }
    return this.regroup(names);
  }

  regroup(names: Readonly<Record<string, string>>): Map<number, string> {
    const keys = regroupVoices({
      samples: this.samples,
      lines: [...this.lines.values()],
      names,
      ...(this.target === undefined ? {} : { target: this.target }),
    });
    const became = new Map<string, Map<string, number>>();
    for (const s of this.target === undefined ? this.samples : this.lines.values()) {
      const to = keys.get(s.at) ?? s.key;
      const counts = became.get(s.key) ?? new Map<string, number>();
      counts.set(to, (counts.get(to) ?? 0) + 1);
      became.set(s.key, counts);
      s.key = to;
    }
    const mostOf = (key: string) => {
      let best = key;
      let most = 0;
      for (const [to, n] of became.get(key) ?? []) {
        if (n > most) {
          most = n;
          best = to;
        }
      }
      return best;
    };
    for (const [label, key] of this.byLabel) this.byLabel.set(label, mostOf(key));
    if (this.last) this.last = mostOf(this.last);
    return keys;
  }
}
