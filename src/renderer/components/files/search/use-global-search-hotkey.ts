/**
 * useGlobalSearchHotkey — Cmd/Ctrl+F window-level keybinding.
 *
 * Contract:
 *   - Registers a `keydown` listener on `window` for the duration of the
 *     calling component's mount lifetime.
 *   - When Cmd+F (macOS) or Ctrl+F (Windows / Linux) is pressed the default
 *     browser action is suppressed and the element referenced by `inputRef`
 *     receives `.focus()` followed by `.select()` — matching VSCode's
 *     behaviour of selecting all existing text so the user can replace it.
 *   - The listener is removed on unmount; no cleanup is needed by callers.
 *
 * No search logic lives here — the hook is concerned only with routing the
 * hotkey to the correct DOM element.
 */

import { useEffect } from "react";

export function useGlobalSearchHotkey(inputRef: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // inputRef is a stable ref object — the identity never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
