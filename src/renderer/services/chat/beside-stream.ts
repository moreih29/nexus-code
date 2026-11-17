/**
 * A tab's state as the parts beside a streaming reply see it: the side
 * panel and the composer show nothing of the reply's text, so a chunk of
 * it, which changes only the model's `streaming`, `turn` and `lastSeq`,
 * leaves them the state they had and they do not render.
 */
import { useRef } from "react";
import type { ChatModel } from "./model";
import type { ChatTabState } from "./store";

/** What a chunk of a streaming reply changes, and what reads the state beside it does not read. */
const STREAM_KEYS: ReadonlySet<keyof ChatModel> = new Set(["streaming", "turn", "lastSeq"]);

/** Whether `next` differs from `prev` in the reply's stream alone, or not at all. */
export function sameBesideStream(prev: ChatTabState, next: ChatTabState): boolean {
  if (prev === next) return true;
  if (!sameKeys(prev, next, (key) => key === "model")) return false;
  return sameKeys(prev.model, next.model, (key) => STREAM_KEYS.has(key as keyof ChatModel));
}

function sameKeys<T extends object>(a: T, b: T, skip: (key: string) => boolean): boolean {
  if (a === b) return true;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of Object.keys(ra)) if (!skip(key) && ra[key] !== rb[key]) return false;
  for (const key of Object.keys(rb)) if (!skip(key) && !(key in ra)) return false;
  return true;
}

/**
 * The state, kept the same object while only the reply's stream changes.
 * What takes it must read none of `model.streaming`, `model.turn` and
 * `model.lastSeq`: those it has are the ones of the last other change.
 */
export function useStateBesideStream(state: ChatTabState): ChatTabState {
  const kept = useRef(state);
  if (!sameBesideStream(kept.current, state)) kept.current = state;
  return kept.current;
}
