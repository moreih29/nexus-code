import type { TFunction } from "i18next";
import enSettings from "../../../shared/i18n/locales/en/settings.json";
import { COMMANDS, type CommandId } from "../../../shared/keybindings/commands";
import {
  findDisplayPrimary,
  KEYBINDINGS,
  type KeybindingDecl,
} from "../../../shared/keybindings/index";
import { chordToLabel } from "../../../shared/keybindings/keybinding-parse";

const COMMAND_NAMES_EN: Partial<Record<CommandId, string>> = commandNames(
  enSettings.keybindings.command,
);

function commandNames(tree: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[`${prefix}${key}`, value]]
        : Object.entries(commandNames(value as object, `${prefix}${key}.`)),
    ),
  );
}

export type MenuItemSpec =
  | { type: "separator" }
  | { type: "role"; role: ElectronRole; label?: string; accelerator?: string; visible?: boolean }
  | { type: "submenu"; label: string; submenu: MenuItemSpec[]; role?: ElectronSubmenuRole }
  | { type: "command"; label: string; command: CommandId; accelerator?: string }
  | { type: "action"; label: string; action: MenuAction };

export type MenuAction = "reloadWindow";

export type ElectronRole =
  | "about"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "selectAll"
  | "toggleDevTools"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "togglefullscreen"
  | "minimize"
  | "zoom"
  | "front";

export type ElectronSubmenuRole = "appMenu" | "editMenu" | "windowMenu";

interface BuildMenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  t?: TFunction;
  bindings?: readonly KeybindingDecl[];
}

export function buildMenuTemplate(opts: BuildMenuOptions): MenuItemSpec[] {
  const menu: MenuItemSpec[] = [];
  const { t, platform } = opts;
  const isMac = platform === "darwin";

  if (isMac) {
    menu.push(appMenu(opts.appName, t));
  }

  menu.push(fileMenu(isMac, t));
  menu.push(editMenu(t));
  menu.push(viewMenu(platform, t));
  menu.push(workspaceMenu(t));

  if (isMac) {
    menu.push(windowMenu(t));
  }

  return enrichWithKeybindings(menu, isMac, opts.bindings ?? KEYBINDINGS);
}

function cmd(label: string, command: CommandId): MenuItemSpec {
  return { type: "command", label, command };
}

function command(id: CommandId, t?: TFunction): MenuItemSpec {
  const label = t != null ? t(`settings:keybindings.command.${id}`) : COMMAND_NAMES_EN[id];
  return cmd(label ?? id, id);
}

function appMenu(appName: string, t?: TFunction): MenuItemSpec {
  return {
    type: "submenu",
    label: appName,
    role: "appMenu",
    submenu: [
      {
        type: "role",
        role: "about",
        label: t != null ? t("menu:appMenu.about", { appName }) : `About ${appName}`,
      },
      cmd(
        t != null ? t("menu:appMenu.checkForUpdates") : "Check for Updates…",
        COMMANDS.updatesCheck,
      ),
      cmd(
        t != null ? t("menu:appMenu.releaseNotes") : "Release Notes",
        COMMANDS.updatesReleaseNotes,
      ),
      { type: "separator" },
      cmd(t != null ? t("menu:appMenu.settings") : "Settings…", COMMANDS.settingsOpen),
      { type: "separator" },
      { type: "role", role: "hide" },
      { type: "role", role: "hideOthers" },
      { type: "role", role: "unhide" },
      { type: "separator" },
      { type: "role", role: "quit" },
    ],
  };
}

function fileMenu(isMac: boolean, t?: TFunction): MenuItemSpec {
  const items: MenuItemSpec[] = [
    command(COMMANDS.fileNew, t),
    cmd(t != null ? t("menu:file.newWorkspace") : "New Workspace…", COMMANDS.workspaceAdd),
    cmd(t != null ? t("menu:file.newTask") : "New Task…", COMMANDS.taskNew),
    { type: "separator" },
    cmd(t != null ? t("menu:file.openFile") : "Open File…", COMMANDS.fileOpen),
    cmd(t != null ? t("menu:file.save") : "Save", COMMANDS.fileSave),
    { type: "separator" },
    command(COMMANDS.tabClose, t),
    command(COMMANDS.tabCloseOthers, t),
    { type: "separator" },
    command(COMMANDS.filesRefresh, t),
  ];

  if (!isMac) {
    items.push({ type: "separator" });
    items.push(cmd(t != null ? t("menu:appMenu.settings") : "Settings…", COMMANDS.settingsOpen));
    items.push(
      cmd(
        t != null ? t("menu:appMenu.releaseNotes") : "Release Notes",
        COMMANDS.updatesReleaseNotes,
      ),
    );
    items.push({ type: "separator" });
    items.push({ type: "role", role: "quit", label: t != null ? t("menu:file.exit") : "Exit" });
  }

  return { type: "submenu", label: t != null ? t("menu:file.label") : "File", submenu: items };
}

function editMenu(t?: TFunction): MenuItemSpec {
  return {
    type: "submenu",
    label: t != null ? t("menu:edit.label") : "Edit",
    role: "editMenu",
    submenu: [
      { type: "role", role: "undo" },
      { type: "role", role: "redo" },
      { type: "separator" },
      { type: "role", role: "cut" },
      { type: "role", role: "copy" },
      { type: "role", role: "paste" },
      { type: "role", role: "pasteAndMatchStyle" },
      { type: "role", role: "selectAll" },
    ],
  };
}

function revealLabel(platform: NodeJS.Platform, t?: TFunction): string {
  if (platform === "darwin") return t != null ? t("menu:view.revealInFinder") : "Reveal in Finder";
  if (platform === "win32") {
    return t != null ? t("menu:view.revealInExplorer") : "Reveal in File Explorer";
  }
  return t != null ? t("menu:view.openContainingFolder") : "Open Containing Folder";
}

function viewMenu(platform: NodeJS.Platform, t?: TFunction): MenuItemSpec {
  return {
    type: "submenu",
    label: t != null ? t("menu:view.label") : "View",
    submenu: [
      command(COMMANDS.workbenchToggleFilesPanel, t),
      command(COMMANDS.workbenchToggleSidebar, t),
      command(COMMANDS.workbenchToggleAgentView, t),
      command(COMMANDS.chatTogglePanel, t),
      { type: "separator" },
      cmd(revealLabel(platform, t), COMMANDS.pathReveal),
      command(COMMANDS.pathCopy, t),
      command(COMMANDS.pathCopyRelative, t),
      { type: "separator" },
      {
        type: "action",
        label: t != null ? t("menu:view.reloadWindow") : "Reload Window",
        action: "reloadWindow",
      },
      { type: "role", role: "toggleDevTools" },
      { type: "separator" },
      { type: "role", role: "resetZoom" },
      { type: "role", role: "zoomIn" },
      ...zoomInEqualKey(platform),
      { type: "role", role: "zoomOut" },
      { type: "separator" },
      { type: "role", role: "togglefullscreen" },
    ],
  };
}

function zoomInEqualKey(platform: NodeJS.Platform): MenuItemSpec[] {
  if (platform === "darwin") return [];
  return [{ type: "role", role: "zoomIn", accelerator: "CmdOrCtrl+=", visible: false }];
}

function workspaceMenu(t?: TFunction): MenuItemSpec {
  return {
    type: "submenu",
    label: t != null ? t("menu:workspace.label") : "Workspace",
    submenu: [
      command(COMMANDS.workspaceFocusPrev, t),
      command(COMMANDS.workspaceFocusNext, t),
      { type: "separator" },
      command(COMMANDS.groupSplitRight, t),
      command(COMMANDS.groupSplitDown, t),
      command(COMMANDS.groupClose, t),
      { type: "separator" },
      command(COMMANDS.groupFocusLeft, t),
      command(COMMANDS.groupFocusRight, t),
      command(COMMANDS.groupFocusUp, t),
      command(COMMANDS.groupFocusDown, t),
    ],
  };
}

function windowMenu(t?: TFunction): MenuItemSpec {
  return {
    type: "submenu",
    label: t != null ? t("menu:window.label") : "Window",
    role: "windowMenu",
    submenu: [
      { type: "role", role: "minimize" },
      { type: "role", role: "zoom" },
      { type: "separator" },
      { type: "role", role: "front" },
    ],
  };
}

function enrichWithKeybindings(
  specs: MenuItemSpec[],
  isMac: boolean,
  bindings: readonly KeybindingDecl[],
): MenuItemSpec[] {
  return specs.map((spec): MenuItemSpec => {
    if (spec.type === "submenu") {
      return { ...spec, submenu: enrichWithKeybindings(spec.submenu, isMac, bindings) };
    }
    if (spec.type !== "command") return spec;

    const primary = findDisplayPrimary(bindings, spec.command, isMac);
    if (primary?.primary !== undefined) {
      return { ...spec, accelerator: primary.primary };
    }
    const chord = bindings.find((b) => b.command === spec.command && b.chord !== undefined);
    if (chord?.chord !== undefined) {
      const label = chordToLabel(chord.chord, { isMac });
      return { ...spec, label: `${spec.label} [${label}]` };
    }
    return spec;
  });
}
