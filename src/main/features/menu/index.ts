import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { TFunction } from "i18next";
import type { CommandId } from "../../../shared/keybindings/commands";
import { ALL_COMMAND_IDS, COMMANDS } from "../../../shared/keybindings/commands";
import { KEYBINDINGS } from "../../../shared/keybindings/index";
import {
  applyKeybindingOverrides,
  type KeybindingOverride,
} from "../../../shared/keybindings/overrides";
import { getActiveAppWindow } from "../window/app-windows";
import { buildMenuTemplate, type MenuAction, type MenuItemSpec } from "./template";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(ALL_COMMAND_IDS);

export interface InstallAppMenuOptions {
  onCheckForUpdates?: () => void;
  t?: TFunction;
  keybindingOverrides?: readonly KeybindingOverride[];
}

export function installAppMenu(options: InstallAppMenuOptions = {}): void {
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: app.getName(),
    t: options.t,
    bindings: applyKeybindingOverrides(KEYBINDINGS, options.keybindingOverrides, KNOWN_COMMANDS),
  });

  const electronTemplate = template.map((spec) => toElectron(spec, options));
  Menu.setApplicationMenu(Menu.buildFromTemplate(electronTemplate));
}

function toElectron(
  spec: MenuItemSpec,
  options: InstallAppMenuOptions,
): MenuItemConstructorOptions {
  switch (spec.type) {
    case "separator":
      return { type: "separator" };

    case "role": {
      const base: MenuItemConstructorOptions =
        spec.label !== undefined ? { role: spec.role, label: spec.label } : { role: spec.role };
      if (spec.role === "copy") base.registerAccelerator = false;
      if (spec.accelerator !== undefined) base.accelerator = spec.accelerator;
      if (spec.visible !== undefined) base.visible = spec.visible;
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
        registerAccelerator: false,
        click: () => fireCommand(spec.command, options),
      };

    case "action":
      return { label: spec.label, click: () => runAction(spec.action) };
  }
}

function runAction(action: MenuAction): void {
  switch (action) {
    case "reloadWindow": {
      const win = getActiveAppWindow();
      if (win && !win.isDestroyed()) win.webContents.reload();
      return;
    }
  }
}

function fireCommand(id: CommandId, options: InstallAppMenuOptions): void {
  if (id === COMMANDS.updatesCheck && options.onCheckForUpdates !== undefined) {
    options.onCheckForUpdates();
    return;
  }

  const win = getActiveAppWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("ipc:event", "command", "invoke", { id });
}
