import type { EditorInput } from "./types";

export interface EditorRevealRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface PendingEditorReveal extends EditorInput {
  range: EditorRevealRange;
}

type PendingRevealListener = (input: PendingEditorReveal) => void;

const pendingByEditor = new Map<string, PendingEditorReveal>();
const listeners = new Set<PendingRevealListener>();

function keyFor(input: EditorInput): string {
  return `${input.workspaceId}\u0000${input.filePath}`;
}

export function requestEditorReveal(input: PendingEditorReveal): void {
  pendingByEditor.set(keyFor(input), input);
  for (const listener of listeners) listener(input);
}

export function takePendingEditorReveal(input: EditorInput): EditorRevealRange | null {
  const key = keyFor(input);
  const pending = pendingByEditor.get(key);
  if (!pending) return null;
  pendingByEditor.delete(key);
  return pending.range;
}

export function subscribePendingEditorReveal(listener: PendingRevealListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetPendingEditorRevealsForTests(): void {
  pendingByEditor.clear();
  listeners.clear();
}
