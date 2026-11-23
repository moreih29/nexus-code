import { useRef } from "react";
import type { ChatModel } from "./model";
import type { ChatTabState } from "./store";

const STREAM_KEYS: ReadonlySet<keyof ChatModel> = new Set(["streaming", "turn", "lastSeq"]);

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

export function useStateBesideStream(state: ChatTabState): ChatTabState {
  const kept = useRef(state);
  if (!sameBesideStream(kept.current, state)) kept.current = state;
  return kept.current;
}
