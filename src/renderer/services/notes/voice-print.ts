/**
 * A recording's voices told apart by voice print as it records
 * (src/shared/notes/voices.ts): the take's audio is kept for a while, each
 * line's goes to the model when its words are final, and the line takes the
 * voice it is nearest (or a new one). Every so often all the lines are
 * grouped again, which may move earlier lines to the voice they belong to.
 * Until its voice print is known, a line goes with the voice its server
 * label had last. That key is only shown for now: a new voice's key is
 * picked among the lines' voices that are known, so lines coming in while
 * the first is still heard don't move the numbering on ("3" for the first
 * voice, after two keys shown for a moment).
 */
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
/** How much of the take's audio is kept, for lines whose words come late. */
const KEEP_SECONDS = 120;
/** How often all the lines are grouped again, in the recording's time. */
export const REGROUP_MS = 15_000;
/** Shorter lines are not heard for a voice print. */
const MIN_PRINT_MS = 400;

/** How long a recording waits, as it starts, for the model to answer: it goes on without. */
const PROBE_MS = 5000;

let availability: Promise<boolean> | undefined;

/** Share the in-flight model probe and remember successful initialization. */
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

/** Starting a recording waits only briefly for the model. */
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
  /** The line's start and end in the recording (ms): `at` is which line it is. */
  at: number;
  endAt: number;
  /** Its start and end in the take's audio (ms). */
  startMs: number;
  endMs: number;
  /** The server's label for its voice, within the take. */
  label: string;
}

export class VoiceTracker {
  private readonly samples: VoiceSample[] = [];
  private readonly lines = new Map<number, VoiceLine>();
  private readonly pendingPins = new Map<number, string>();
  private readonly ring = new Float32Array(VOICE_PRINT_RATE * KEEP_SECONDS);
  /** How many samples of the take have been heard. */
  private heard = 0;
  /** The take's server labels, by the voice each went with last. */
  private readonly byLabel = new Map<string, string>();
  private last: string | null = null;
  private lastRegroup = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  /** The lines (by `at`) whose voice is still being worked out. */
  private readonly pending = new Set<number>();

  constructor(private readonly target?: number) {}

  /** A new take: its audio starts over, and so do the server's labels. */
  startTake(): void {
    this.heard = 0;
    this.byLabel.clear();
  }

  /** The take's audio as it is captured, 16 kHz. */
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

  /**
   * The voice for words under `label` before their voice print is known.
   * `taken` is the keys known: not those of the lines still `undecided`.
   */
  provisional(label: string, taken: Iterable<string>): string {
    return this.byLabel.get(label) ?? this.last ?? nextVoiceKey(taken);
  }

  /** Whether the line at `at` is still being heard: its key is only the one shown for now. */
  undecided(at: number): boolean {
    return this.pending.has(at);
  }

  /** The take's audio from `startMs` to `endMs` (its first 10 s), or null when it is gone. */
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

  /**
   * A line whose words are final: the voice it goes with, and, when all the
   * lines were grouped again, every line's voice by `at`. Lines are heard
   * in the order they come; `taken` is the keys known, as `provisional`'s.
   */
  lineHeard(
    line: HeardLine,
    taken: () => Iterable<string>,
    names: () => Readonly<Record<string, string>>,
  ): Promise<{ key: string; regrouped: Map<number, string> | null }> {
    // Its audio now, before the ring moves on.
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

  /** Once the lines heard so far have their voice prints. */
  settled(): Promise<void> {
    return this.queue.then(() => {});
  }

  /** The user moved lines to voice `key`: they stay with it, and all are grouped again. */
  pin(
    ats: readonly number[],
    key: string,
    names: Readonly<Record<string, string>>,
  ): Map<number, string> {
    for (const at of ats) {
      if (this.pending.has(at)) this.pendingPins.set(at, key);
      const line = this.lines.get(at);
      if (!line) continue;
      line.key = key;
      line.pinned = true;
    }
    return this.regroup(names);
  }

  /** All the lines grouped again: each one's voice, by `at`. */
  regroup(names: Readonly<Record<string, string>>): Map<number, string> {
    const keys = regroupVoices({
      samples: this.samples,
      lines: [...this.lines.values()],
      names,
      ...(this.target === undefined ? {} : { target: this.target }),
    });
    // What each voice's lines went to, to move the labels along with them.
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
