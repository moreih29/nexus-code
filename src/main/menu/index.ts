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
import type { CommandId } from "../../shared/commands";
import { isMac } from "../platform";
import { buildMenuTemplate, type MenuItemSpec } from "./template";

export function installAppMenu(): void {
  const template = buildMenuTemplate({
    isMac: isMac(),
    appName: app.getName(),
  });

  const electronTemplate = template.map(toElectron);
  Menu.setApplicationMenu(Menu.buildFromTemplate(electronTemplate));
}

function toElectron(spec: MenuItemSpec): MenuItemConstructorOptions {
  switch (spec.type) {
    case "separator":
      return { type: "separator" };

    case "role":
      return spec.label !== undefined
        ? { role: spec.role, label: spec.label }
        : { role: spec.role };

    case "submenu":
      return spec.role !== undefined
        ? { label: spec.label, role: spec.role, submenu: spec.submenu.map(toElectron) }
        : { label: spec.label, submenu: spec.submenu.map(toElectron) };

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
        click: () => fireCommand(spec.command),
      };
  }
}

/**
 * Bridge a menu click into the focused renderer. Commands operate on
 * the active workspace / active editor / active group — all of which
 * are renderer state — so we route through IPC rather than running
 * anything in the main process.
 */
function fireCommand(id: CommandId): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send("ipc:event", "command", "invoke", { id });
}
