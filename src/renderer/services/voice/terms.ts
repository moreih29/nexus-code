import { MAX_VOICE_TERM_CHARS, MAX_VOICE_TERMS } from "../../../shared/remote/voice";

export function splitTerms(input: string): string[] {
  return input
    .split(/[,，、\r\n]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

export type AddTerms =
  | { status: "ok"; terms: string[] }
  | { status: "none" }
  | { status: "too-long" }
  | { status: "too-many" };

export function addTerms(list: readonly string[], input: string): AddTerms {
  const typed = splitTerms(input);
  if (typed.some((term) => term.length > MAX_VOICE_TERM_CHARS)) return { status: "too-long" };
  const seen = new Set(list.map((term) => term.toLowerCase()));
  const added: string[] = [];
  for (const term of typed) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(term);
  }
  if (added.length === 0) return { status: "none" };
  if (list.length + added.length > MAX_VOICE_TERMS) return { status: "too-many" };
  return { status: "ok", terms: [...list, ...added] };
}

export function removeTerm(list: readonly string[], term: string): string[] {
  return list.filter((t) => t !== term);
}

export function pastedTerms(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(", ");
}
