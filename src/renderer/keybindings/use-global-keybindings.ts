/**
 * Mount the renderer's global keybinding plumbing for the lifetime of
 * the app:
 *   1. Register every command implementation through the
 *      {@link ../commands/registry} so menu and keyboard share a single
 *      execution path.
 *   2. Attach the capture-phase keydown listener that hands events to
 *      the dispatcher.
 *
 * Domain handlers live in `./commands/<domain>-commands.ts`. This hook
 * is now wiring-only: command authorship belongs in those domain
 * modules so adding a binding is a one-file change.
 */

import { useEffect } from "react";
import { registerFileCommands } from "./commands/file-commands";
import { registerGroupCommands } from "./commands/group-commands";
import { registerPaletteCommands } from "./commands/palette-commands";
import { registerPathCommands } from "./commands/path-commands";
import { registerTabCommands } from "./commands/tab-commands";
import { handleGlobalKeyDown } from "./dispatcher";

export function useGlobalKeybindings(): void {
  useEffect(() => {
    const unregister: Array<() => void> = [
      ...registerFileCommands(),
      ...registerTabCommands(),
      ...registerGroupCommands(),
      ...registerPathCommands(),
      ...registerPaletteCommands(),
    ];

    // Capture phase puts our handler ahead of Monaco's standalone
    // keybinding service (which sits on the editor container in the
    // bubble phase). Without capture, ⌘K keystrokes typed inside
    // Monaco never reach our chord pipeline because Monaco's
    // dispatcher consumes them for its own ⌘K-led shortcuts.
    function onKeyDown(e: KeyboardEvent) {
      if (handleGlobalKeyDown(e)) {
        // We claimed the event — stop propagation so Monaco / xterm
        // don't re-process the same key. (Cocoa menu accelerators are
        // a separate path and can still fire; that's intentional and
        // benign for our currently-bound commands.)
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      for (const off of unregister) off();
    };
  }, []);
}
