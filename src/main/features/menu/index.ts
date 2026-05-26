/**
 * Install the Application Menu.
 *
 * Translates the pure {@link buildMenuTemplate} output into Electron's
 * `MenuItemConstructorOptions` shape and binds command items to a
 * `webContents.send` that the renderer's command bridge receives.
 *
 * Called once at app boot. Re-running it replaces the previous menu —
 * but we intentionally don't expose a re-install path: command IDs are
 * static, and re-applying the menu would briefly drop pending menu
 * accelerators on macOS.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { COMMANDS } from "../../../shared/keybindings/commands";
import type { CommandId } from "../../../shared/keybindings/commands";
import { isMac } from "../../infra/platform";
import { buildMenuTemplate, type MenuItemSpec } from "./template";

export interface InstallAppMenuOptions {
  /** Called when the user clicks "Check for Updates..." in the App menu. */
  onCheckForUpdates?: () => void;
}

export function installAppMenu(options: InstallAppMenuOptions = {}): void {
  const template = buildMenuTemplate({
    isMac: isMac(),
    appName: app.getName(),
  });

  const electronTemplate = template.map((spec) => toElectron(spec, options));
  Menu.setApplicationMenu(Menu.buildFromTemplate(electronTemplate));
}

function toElectron(spec: MenuItemSpec, options: InstallAppMenuOptions): MenuItemConstructorOptions {
  switch (spec.type) {
    case "separator":
      return { type: "separator" };

    case "role": {
      // Selective accelerator unregistration for `copy`:
      //   macOS Cocoa intercepts ⌘C before the renderer keydown listener fires
      //   and dispatches `webContents.copy()`, which only copies the *DOM*
      //   selection. xterm.js v6 renders to a canvas — its visible selection
      //   is a canvas overlay, not a DOM `window.getSelection()` — so the
      //   Cocoa-driven copy writes empty to the clipboard.
      //
      //   `registerAccelerator: false` keeps the menu item (and its visible
      //   ⌘C label) but skips the OS-level shortcut registration. Then the
      //   keydown event flows to the renderer, where xterm's customKeyEvent
      //   handler can copy the canvas selection via IPC, Monaco handles its
      //   own ⌘C, and plain `<input>`/`<textarea>` get Chromium's native
      //   in-element copy handler (which does not depend on the menu role).
      //
      //   Cut/paste/selectAll keep the default registration because they have
      //   no canvas-vs-DOM mismatch — Cocoa's native dispatch reaches the
      //   correct target in every focus context.
      const base: MenuItemConstructorOptions =
        spec.label !== undefined
          ? { role: spec.role, label: spec.label }
          : { role: spec.role };
      if (spec.role === "copy") base.registerAccelerator = false;
      return base;
    }

    case "submenu":
      return spec.role !== undefined
        ? {
            label: spec.label,
            role: spec.role,
            submenu: spec.submenu.map((s) => toElectron(s, options)),
          }
        : { label: spec.label, submenu: spec.submenu.map((s) => toElectron(s, options)) };

    case "command":
      return {
        label: spec.label,
        accelerator: spec.accelerator,
        // macOS Cocoa intercepts menu accelerators *before* they reach
        // the renderer's keydown listener. Letting the menu register
        // ⌘W (or any other command shortcut) means the renderer never
        // sees the second key of a chord like ⌘K ⌘W — Cocoa fires
        // `tab.close` from the menu while the renderer's pending state
        // sits idle until it times out.
        //
        // `registerAccelerator: false` tells Electron to *display* the
        // shortcut in the menu but skip the system registration, so
        // the renderer becomes the sole owner of every keystroke.
        // Single-key bindings still work (the renderer's BINDINGS
        // table catches them); chord bindings work for the same
        // reason. Mouse clicks on menu items still fire `click`, so
        // discoverability is preserved.
        //
        // Role items (Cut/Copy/Paste/Quit/Hide/DevTools/zoom/…) keep
        // the default registration so Cocoa continues to handle them
        // natively against whatever element owns focus.
        registerAccelerator: false,
        click: () => fireCommand(spec.command, options),
      };
  }
}

/**
 * Bridge a menu click into the appropriate handler.
 *
 * Main-process commands (e.g. `updates.check`) are dispatched directly
 * to an injected callback so no renderer round-trip is needed.
 * All other commands are forwarded to the focused renderer via IPC, since
 * they operate on renderer-owned state (active workspace, active editor, etc.).
 */
function fireCommand(id: CommandId, options: InstallAppMenuOptions): void {
  if (id === COMMANDS.updatesCheck && options.onCheckForUpdates !== undefined) {
    options.onCheckForUpdates();
    return;
  }

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send("ipc:event", "command", "invoke", { id });
}
