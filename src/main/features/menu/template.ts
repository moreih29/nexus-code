import type { TFunction } from "i18next";
import { COMMANDS, type CommandId } from "../../../shared/keybindings/commands";
import {
  findDisplayPrimary,
  KEYBINDINGS,
  type KeybindingDecl,
} from "../../../shared/keybindings/index";
import { chordToLabel } from "../../../shared/keybindings/keybinding-parse";

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
        t != null ? t("menu:appMenu.checkForUpdates") : "Check for Updates...",
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
    cmd(t != null ? t("menu:file.newFile") : "New File", COMMANDS.fileNew),
    cmd(t != null ? t("menu:file.newWorkspace") : "New Workspace…", COMMANDS.workspaceAdd),
    cmd(t != null ? t("menu:file.newTask") : "New Task…", COMMANDS.taskNew),
    { type: "separator" },
    cmd(t != null ? t("menu:file.openFile") : "Open File…", COMMANDS.fileOpen),
    cmd(t != null ? t("menu:file.save") : "Save", COMMANDS.fileSave),
    { type: "separator" },
    cmd(t != null ? t("menu:file.closeEditor") : "Close Tab", COMMANDS.tabClose),
    cmd(t != null ? t("menu:file.closeOthers") : "Close Other Tabs", COMMANDS.tabCloseOthers),
    { type: "separator" },
    cmd(t != null ? t("menu:file.refreshFiles") : "Refresh Files", COMMANDS.filesRefresh),
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
      cmd(
        t != null ? t("menu:view.toggleFilesPanel") : "Toggle Files Panel",
        COMMANDS.workbenchToggleFilesPanel,
      ),
      cmd(
        t != null ? t("menu:view.toggleSidebar") : "Toggle Sidebar",
        COMMANDS.workbenchToggleSidebar,
      ),
      cmd(
        t != null ? t("menu:view.toggleAgentView") : "Toggle Agent View",
        COMMANDS.workbenchToggleAgentView,
      ),
      cmd(
        t != null ? t("menu:view.toggleChatPanel") : "Toggle Chat Side Panel",
        COMMANDS.chatTogglePanel,
      ),
      { type: "separator" },
      cmd(revealLabel(platform, t), COMMANDS.pathReveal),
      cmd(t != null ? t("menu:view.copyPath") : "Copy Path", COMMANDS.pathCopy),
      cmd(
        t != null ? t("menu:view.copyRelativePath") : "Copy Relative Path",
        COMMANDS.pathCopyRelative,
      ),
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
      cmd(
        t != null ? t("menu:workspace.previousWorkspace") : "Previous Workspace",
        COMMANDS.workspaceFocusPrev,
      ),
      cmd(
        t != null ? t("menu:workspace.nextWorkspace") : "Next Workspace",
        COMMANDS.workspaceFocusNext,
      ),
      { type: "separator" },
      cmd(t != null ? t("menu:workspace.splitRight") : "Split Right", COMMANDS.groupSplitRight),
      cmd(t != null ? t("menu:workspace.splitDown") : "Split Down", COMMANDS.groupSplitDown),
      cmd(t != null ? t("menu:workspace.closeGroup") : "Close Group", COMMANDS.groupClose),
      { type: "separator" },
      cmd(
        t != null ? t("menu:workspace.focusGroupLeft") : "Focus Group Left",
        COMMANDS.groupFocusLeft,
      ),
      cmd(
        t != null ? t("menu:workspace.focusGroupRight") : "Focus Group Right",
        COMMANDS.groupFocusRight,
      ),
      cmd(t != null ? t("menu:workspace.focusGroupUp") : "Focus Group Up", COMMANDS.groupFocusUp),
      cmd(
        t != null ? t("menu:workspace.focusGroupDown") : "Focus Group Down",
        COMMANDS.groupFocusDown,
      ),
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
