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
 *   - `commandPaletteFocus` — target is inside the command palette modal.
 *
 * Unknown names resolve to `false`. Treating an unknown context key
 * as "not active" matches VSCode's behaviour and keeps a typo'd
 * binding fail-safe (it just won't match) rather than fail-loud.
 */

/**
 * Resolves a `when`-clause context key (e.g. `editorFocus`, `fileTreeFocus`)
 * against the currently focused element on a keyboard event. Returns `false`
 * for unknown keys so unrecognised conditions never accidentally fire a
 * binding.
 */
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
    case "commandPaletteFocus":
      return isInCommandPalette(target);
    default:
      return false;
  }
}

function isInCodeEditor(target: HTMLElement | null): boolean {
  return closest(target, ".cm-editor") != null || closest(target, ".monaco-editor") != null;
}

// DATA-LOSS-CRITICAL CONTRACT: `isInPlainInput` は "本物の" テキスト入力
// (inline create/rename edit row, 検索ボックスなど) にフォーカスがある間だけ
// true を返さなければならない。`inputFocus` を `when` 条件に持つキーバインド
// (例: `fileRename` の `when: "fileTreeFocus && !inputFocus"`) はこの関数を
// 頼りに edit row が開いている間の二重発火を抑制する。
// 誤って false を返すと、rename/create 入力中に F2 が再発火して入力データが
// 失われる。変更時はキーボードテストを必ず実施すること。
function isInPlainInput(target: HTMLElement | null): boolean {
  if (!target) return false;
  // Embedded editors expose their textarea/contentEditable host. We
  // intentionally classify those under `editorFocus` rather than
  // `inputFocus`, so callers can scope a binding to "real" inputs
  // only — keep this exclusion *before* the input/textarea checks so
  // a Monaco-hosted contentEditable doesn't trip the input branch.
  if (closest(target, ".cm-editor") != null) return false;
  if (closest(target, ".monaco-editor") != null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable === true) return true;
  return false;
}

function isInFileTree(target: HTMLElement | null): boolean {
  return closest(target, '[role="tree"]') != null;
}

function isInTerminal(target: HTMLElement | null): boolean {
  return closest(target, ".xterm") != null;
}

function isInCommandPalette(target: HTMLElement | null): boolean {
  return closest(target, "[data-command-palette-root]") != null;
}

function closest(target: HTMLElement | null, selector: string): Element | null {
  if (!target || typeof target.closest !== "function") return null;
  return target.closest(selector);
}
