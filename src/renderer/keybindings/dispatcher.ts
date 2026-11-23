import { executeCommand } from "../commands/registry";
import {
  __setClockForTests,
  chordClock,
  clearPending,
  enterPending,
  getPendingLeader,
  isModifierKeyOnly,
  purgeExpired,
  __resetForTests as resetChordState,
} from "./chord-state";
import { evaluateContextKey } from "./context-keys";
import { resolveEvent } from "./resolver";

export { __setClockForTests as __setChordClockForTests };

let editorChordSince: number | null = null;

const EDITOR_CHORD_TIMEOUT_MS = 5000;

function editorTakesChords(e: KeyboardEvent): boolean {
  return !evaluateContextKey("isMac", e) && evaluateContextKey("editorFocus", e);
}

export function __resetChordStateForTests(): void {
  resetChordState();
  editorChordSince = null;
}

export function handleGlobalKeyDown(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return false;

  purgeExpired();

  if (isModifierKeyOnly(e)) return false;

  if (editorChordSince !== null) {
    const live = chordClock() - editorChordSince < EDITOR_CHORD_TIMEOUT_MS;
    editorChordSince = null;
    if (live && evaluateContextKey("editorFocus", e)) return false;
  }

  if (evaluateContextKey("commandPaletteFocus", e)) return false;

  if (evaluateContextKey("keybindingRecorderFocus", e)) return false;

  const pendingLeader = getPendingLeader();
  if (
    pendingLeader !== null &&
    e.key === "Escape" &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey
  ) {
    clearPending();
    e.preventDefault();
    return true;
  }

  const result = resolveEvent(e, pendingLeader);

  switch (result.kind) {
    case "chord-completed":
      e.preventDefault();
      executeCommand(result.command);
      clearPending();
      return true;

    case "chord-mismatch":
      clearPending();
      e.preventDefault();
      return true;

    case "chord-leader":
      if (editorTakesChords(e)) {
        editorChordSince = chordClock();
        return false;
      }
      e.preventDefault();
      enterPending(result.leaderId);
      return true;

    case "single":
      e.preventDefault();
      executeCommand(result.command);
      return true;

    case "none":
      return false;
  }
}
