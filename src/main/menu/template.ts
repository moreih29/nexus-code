/**
 * Pure builder for the Application Menu.
 *
 * Returns a tree of {@link MenuItemSpec} that the Electron-aware
 * installer (`menu.ts`) maps to `MenuItemConstructorOptions`.
 *
 * Single source of truth for keybindings: every command-typed item
 * looks up its accelerator in `shared/keybindings.ts`. Single-key
 * bindings come back through Electron's normal `accelerator` field;
 * chord bindings (`⌘K …`) cannot be Electron-registered, so we
 * suffix the menu label with `[⌘K ⌘W]` exactly as VSCode does.
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
import { COMMANDS, type CommandId } from "../../shared/commands";
import { chordToLabel } from "../../shared/keybinding-parse";
import { findChordBinding, findPrimaryBinding } from "../../shared/keybindings";

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

  return enrichWithKeybindings(menu, opts.isMac);
}

/**
 * Tiny helper that constructs a command spec without an inline
 * accelerator — the post-process step below fills it in by looking up
 * `shared/keybindings.ts`. Keeps the menu structure declarative and
 * removes the parallel-table-of-strings smell.
 */
function cmd(label: string, command: CommandId): MenuItemSpec {
  return { type: "command", label, command };
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
    cmd("Open File…", COMMANDS.fileOpen),
    cmd("Save", COMMANDS.fileSave),
    { type: "separator" },
    cmd("Close Editor", COMMANDS.tabClose),
    cmd("Close Others", COMMANDS.tabCloseOthers),
    { type: "separator" },
    cmd("Refresh Files", COMMANDS.filesRefresh),
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
      cmd("Reveal in Finder", COMMANDS.pathReveal),
      cmd("Copy Path", COMMANDS.pathCopy),
      cmd("Copy Relative Path", COMMANDS.pathCopyRelative),
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
      cmd("Split Right", COMMANDS.groupSplitRight),
      cmd("Split Down", COMMANDS.groupSplitDown),
      cmd("Close Group", COMMANDS.groupClose),
      { type: "separator" },
      cmd("Focus Group Left", COMMANDS.groupFocusLeft),
      cmd("Focus Group Right", COMMANDS.groupFocusRight),
      cmd("Focus Group Up", COMMANDS.groupFocusUp),
      cmd("Focus Group Down", COMMANDS.groupFocusDown),
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

/**
 * Walk the spec tree and fill in `accelerator` (and the chord label
 * suffix) for each command item from `shared/keybindings.ts`. Pure
 * over the spec — no Electron access here.
 *
 * Mirrors VSCode's `withKeybinding` strategy:
 *   - Single-key binding → set `accelerator` (Electron registers it).
 *   - Chord binding → no accelerator, append `[⌘K ⌘W]` to the label
 *     (Electron can't register chords; renderer dispatches them).
 */
function enrichWithKeybindings(specs: MenuItemSpec[], isMac: boolean): MenuItemSpec[] {
  return specs.map((spec): MenuItemSpec => {
    if (spec.type === "submenu") {
      return { ...spec, submenu: enrichWithKeybindings(spec.submenu, isMac) };
    }
    if (spec.type !== "command") return spec;

    const primary = findPrimaryBinding(spec.command);
    if (primary?.primary !== undefined) {
      return { ...spec, accelerator: primary.primary };
    }
    const chord = findChordBinding(spec.command);
    if (chord?.chord !== undefined) {
      const label = chordToLabel(chord.chord, { isMac });
      return { ...spec, label: `${spec.label} [${label}]` };
    }
    return spec;
  });
}
