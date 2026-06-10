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
 *   - `isMac`             — resolved via navigator.platform, not DOM target.
 *                           Always evaluates to the same value for a given
 *                           device; safe to use in `when` expressions.
 *   - `browserTabActive`  — STATE probe (not DOM): the active group's
 *                           active tab is a browser tab. Registered via
 *                           {@link registerContextProbe} by the browser
 *                           command domain. A DOM probe cannot express
 *                           this — the embedded WebContentsView is a
 *                           native view outside the renderer's DOM, so
 *                           the keydown target is never "inside" it.
 *
 * Unknown names resolve to `false`. Treating an unknown context key
 * as "not active" matches VSCode's behaviour and keeps a typo'd
 * binding fail-safe (it just won't match) rather than fail-loud.
 */

// ---------------------------------------------------------------------------
// Dynamic (state-backed) context probes
// ---------------------------------------------------------------------------
//
// Some context keys cannot be derived from the keydown target — they
// describe app *state* (e.g. which tab is active in the focused group).
// Domains register a probe function once at mount; `evaluateContextKey`
// falls back to the probe table for any name the DOM switch doesn't
// handle. Probes must be cheap and synchronous (they run per keydown).

type ContextProbe = () => boolean;

const dynamicProbes = new Map<string, ContextProbe>();

/**
 * Register a state-backed context probe for `name`. Returns an
 * unregister function. Re-registering the same name replaces the probe
 * (last writer wins) — domains are mounted once, so this only matters
 * for tests.
 */
export function registerContextProbe(name: string, probe: ContextProbe): () => void {
  dynamicProbes.set(name, probe);
  return () => {
    if (dynamicProbes.get(name) === probe) dynamicProbes.delete(name);
  };
}

/** Test-only — drop all dynamic probes between tests. */
export function __resetContextProbesForTests(): void {
  dynamicProbes.clear();
}

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
    case "keybindingRecorderFocus":
      return isInKeybindingRecorder(target);
    case "isMac":
      return IS_MAC; // resolved at module load, stable per device
    default: {
      // State-backed keys (e.g. `browserTabActive`) registered by domains.
      const probe = dynamicProbes.get(name);
      if (probe !== undefined) {
        try {
          return probe();
        } catch {
          return false; // a throwing probe must never break dispatch
        }
      }
      return false;
    }
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

// The keybinding recorder must receive EVERY keystroke verbatim —
// including ones the dispatcher would otherwise claim (⌘W, ⌘K, …).
// The dispatcher early-returns when the keydown target sits inside a
// recorder, exactly like the command-palette guard above.
function isInKeybindingRecorder(target: HTMLElement | null): boolean {
  return closest(target, "[data-keybinding-recorder]") != null;
}

function closest(target: HTMLElement | null, selector: string): Element | null {
  if (!target || typeof target.closest !== "function") return null;
  return target.closest(selector);
}

// Stable per-device flag. Evaluated once at module load.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || "");
