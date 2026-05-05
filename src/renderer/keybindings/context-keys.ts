/**
 * Context-key probes for the renderer's `when` expressions.
 *
 * VSCode's contextKeyService maintains a hierarchy of keys whose values
 * are pushed by surfaces as they gain/lose focus. We don't need that
 * machinery yet — every key we use today is a focus probe that can be
 * computed on-the-fly from the keydown event's `target`. So instead of
 * subscribing to focus events and mutating shared state, we evaluate
 * each context key against the current target when the dispatcher
 * needs it.
 *
 * The shape (`(name, event) => boolean`) lets us swap in a real
 * pushed-state implementation later without touching the resolver or
 * binding declarations.
 *
 * Known keys:
 *   - `editorFocus`    — target is inside a code editor (Monaco or
 *                        CodeMirror). Roughly VSCode's `editorFocus`.
 *   - `inputFocus`     — target is an INPUT, TEXTAREA, or
 *                        contentEditable element (a "real" text field,
 *                        not the embedded editors).
 *   - `fileTreeFocus`  — target is inside the file-tree container
 *                        (`role="tree"`).
 *   - `terminalFocus`  — target is inside an xterm.js terminal.
 *
 * Unknown names resolve to `false`. Treating an unknown context key
 * as "not active" matches VSCode's behaviour and keeps a typo'd
 * binding fail-safe (it just won't match) rather than fail-loud.
 */

export type ContextKeyName = "editorFocus" | "inputFocus" | "fileTreeFocus" | "terminalFocus";

export function evaluateContextKey(name: string, event: KeyboardEvent): boolean {
  const target = (event.target as HTMLElement | null) ?? null;
  switch (name) {
    case "editorFocus":
      return isInCodeEditor(target);
    case "inputFocus":
      return isInPlainInput(target);
    case "fileTreeFocus":
      return isInFileTree(target);
    case "terminalFocus":
      return isInTerminal(target);
    default:
      return false;
  }
}

function isInCodeEditor(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.closest(".cm-editor") != null || target.closest(".monaco-editor") != null;
}

function isInPlainInput(target: HTMLElement | null): boolean {
  if (!target) return false;
  // Embedded editors expose their textarea/contentEditable host. We
  // intentionally classify those under `editorFocus` rather than
  // `inputFocus`, so callers can scope a binding to "real" inputs
  // only — keep this exclusion *before* the input/textarea checks so
  // a Monaco-hosted contentEditable doesn't trip the input branch.
  if (target.closest(".cm-editor") != null) return false;
  if (target.closest(".monaco-editor") != null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable === true) return true;
  return false;
}

function isInFileTree(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.closest('[role="tree"]') != null;
}

function isInTerminal(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.closest(".xterm") != null;
}
