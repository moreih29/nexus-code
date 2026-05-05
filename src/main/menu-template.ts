/**
 * Pure builder for the Application Menu.
 *
 * Returns a tree of {@link MenuItemSpec} that the Electron-aware
 * installer (`menu.ts`) maps to `MenuItemConstructorOptions`. Splitting
 * the structure away from the install lets the template be unit-tested
 * without booting Electron — tests assert that, e.g., the File submenu
 * binds Cmd+W to `tab.close` rather than leaving Electron's default
 * "Close Window" accelerator in place.
 *
 * Key conflicts with Electron's default menu (mac):
 *   - Cmd+W   → "Close Window" replaced by "Close Editor" (tab.close).
 *   - Cmd+R   → "Reload" replaced by "Refresh Files" (files.refresh).
 *   - Cmd+⇧+R → "Force Reload" dropped (devs use the DevTools button).
 *
 * Standard editor / window items (Cmd+C/V/X/A/Z, Cmd+M, Cmd+Q, Cmd+H,
 * Cmd+Alt+I) keep their Electron-built `role`s so Chromium and macOS
 * handle them uniformly.
 */
import { type CommandId, COMMANDS } from "../shared/commands";

export type MenuItemSpec =
  | { type: "separator" }
  | { type: "role"; role: ElectronRole; label?: string }
  | { type: "submenu"; label: string; submenu: MenuItemSpec[]; role?: ElectronSubmenuRole }
  | { type: "command"; label: string; command: CommandId; accelerator?: string };

/**
 * Subset of Electron `MenuItemConstructorOptions["role"]` we use.
 * Listed explicitly so tests/types fail fast when a typo creeps in.
 */
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
  isMac: boolean;
  appName: string;
}

export function buildMenuTemplate(opts: BuildMenuOptions): MenuItemSpec[] {
  const menu: MenuItemSpec[] = [];

  if (opts.isMac) {
    menu.push(appMenu(opts.appName));
  }

  menu.push(fileMenu(opts.isMac));
  menu.push(editMenu());
  menu.push(viewMenu());
  menu.push(workspaceMenu());

  if (opts.isMac) {
    menu.push(windowMenu());
  }

  return menu;
}

function appMenu(appName: string): MenuItemSpec {
  return {
    type: "submenu",
    label: appName,
    role: "appMenu",
    submenu: [
      { type: "role", role: "about", label: `About ${appName}` },
      { type: "separator" },
      { type: "role", role: "hide" },
      { type: "role", role: "hideOthers" },
      { type: "role", role: "unhide" },
      { type: "separator" },
      { type: "role", role: "quit" },
    ],
  };
}

function fileMenu(isMac: boolean): MenuItemSpec {
  const items: MenuItemSpec[] = [
    {
      type: "command",
      label: "Open File…",
      command: COMMANDS.fileOpen,
      accelerator: "CmdOrCtrl+E",
    },
    {
      type: "command",
      label: "Save",
      command: COMMANDS.fileSave,
      accelerator: "CmdOrCtrl+S",
    },
    { type: "separator" },
    {
      type: "command",
      label: "Close Editor",
      command: COMMANDS.tabClose,
      accelerator: "CmdOrCtrl+W",
    },
    {
      type: "command",
      label: "Close Others",
      command: COMMANDS.tabCloseOthers,
      // Mac-only in VSCode; Electron parses this same accelerator on
      // every platform, so leaving it on Win/Linux is harmless.
      accelerator: "CmdOrCtrl+Alt+T",
    },
    { type: "separator" },
    {
      type: "command",
      label: "Refresh Files",
      command: COMMANDS.filesRefresh,
      accelerator: "CmdOrCtrl+R",
    },
  ];

  // Win/Linux don't get the App menu, so Quit lives in File.
  if (!isMac) {
    items.push({ type: "separator" });
    items.push({ type: "role", role: "quit", label: "Exit" });
  }

  return { type: "submenu", label: "File", submenu: items };
}

function editMenu(): MenuItemSpec {
  // The role-based Edit menu lets Chromium handle copy/paste/select-all
  // inside any focused input or contenteditable. Defining our own
  // command-based Edit items here would break Monaco's built-in
  // shortcuts (it expects the standard roles to flow through Cocoa).
  return {
    type: "submenu",
    label: "Edit",
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

function viewMenu(): MenuItemSpec {
  return {
    type: "submenu",
    label: "View",
    submenu: [
      {
        type: "command",
        label: "Reveal in Finder",
        command: COMMANDS.pathReveal,
        accelerator: "CmdOrCtrl+Alt+R",
      },
      {
        type: "command",
        label: "Copy Path",
        command: COMMANDS.pathCopy,
        accelerator: "CmdOrCtrl+Alt+C",
      },
      {
        type: "command",
        label: "Copy Relative Path",
        command: COMMANDS.pathCopyRelative,
        accelerator: "CmdOrCtrl+Shift+Alt+C",
      },
      { type: "separator" },
      { type: "role", role: "toggleDevTools" },
      { type: "separator" },
      { type: "role", role: "resetZoom" },
      { type: "role", role: "zoomIn" },
      { type: "role", role: "zoomOut" },
      { type: "separator" },
      { type: "role", role: "togglefullscreen" },
    ],
  };
}

function workspaceMenu(): MenuItemSpec {
  return {
    type: "submenu",
    label: "Workspace",
    submenu: [
      {
        type: "command",
        label: "Split Right",
        command: COMMANDS.groupSplitRight,
        accelerator: "CmdOrCtrl+\\",
      },
      {
        type: "command",
        label: "Split Down",
        command: COMMANDS.groupSplitDown,
        accelerator: "CmdOrCtrl+Shift+\\",
      },
      {
        type: "command",
        label: "Close Group",
        command: COMMANDS.groupClose,
        accelerator: "CmdOrCtrl+Shift+W",
      },
      { type: "separator" },
      {
        type: "command",
        label: "Focus Group Left",
        command: COMMANDS.groupFocusLeft,
        accelerator: "CmdOrCtrl+Alt+Left",
      },
      {
        type: "command",
        label: "Focus Group Right",
        command: COMMANDS.groupFocusRight,
        accelerator: "CmdOrCtrl+Alt+Right",
      },
      {
        type: "command",
        label: "Focus Group Up",
        command: COMMANDS.groupFocusUp,
        accelerator: "CmdOrCtrl+Alt+Up",
      },
      {
        type: "command",
        label: "Focus Group Down",
        command: COMMANDS.groupFocusDown,
        accelerator: "CmdOrCtrl+Alt+Down",
      },
    ],
  };
}

function windowMenu(): MenuItemSpec {
  return {
    type: "submenu",
    label: "Window",
    role: "windowMenu",
    submenu: [
      { type: "role", role: "minimize" },
      { type: "role", role: "zoom" },
      { type: "separator" },
      { type: "role", role: "front" },
    ],
  };
}
