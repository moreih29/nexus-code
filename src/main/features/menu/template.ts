/**
 * Pure builder for the Application Menu.
 *
 * Returns a tree of {@link MenuItemSpec} that the Electron-aware
 * installer (`menu.ts`) maps to `MenuItemConstructorOptions`.
 *
 * Single source of truth for keybindings: every command-typed item
 * looks up its accelerator in `shared/keybindings/index.ts`. Single-key
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
import type { TFunction } from "i18next";
import { COMMANDS, type CommandId } from "../../../shared/keybindings/commands";
import { KEYBINDINGS, type KeybindingDecl } from "../../../shared/keybindings/index";
import { chordToLabel } from "../../../shared/keybindings/keybinding-parse";

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
  /**
   * i18next TFunction for the main-process locale instance.
   * Injected by the caller so this module stays a pure function with no
   * global i18next import.  When omitted the English fallback strings
   * embedded in each builder are used (e.g. in tests that build without i18n).
   */
  t?: TFunction;
  /**
   * EFFECTIVE binding table (defaults + user overrides, merged by
   * `applyKeybindingOverrides`).  Injected by the installer so this
   * module stays pure.  When omitted, falls back to the static
   * `KEYBINDINGS` defaults — correct for tests and for boots with no
   * stored overrides.
   */
  bindings?: readonly KeybindingDecl[];
}

export function buildMenuTemplate(opts: BuildMenuOptions): MenuItemSpec[] {
  const menu: MenuItemSpec[] = [];
  const { t } = opts;

  if (opts.isMac) {
    menu.push(appMenu(opts.appName, t));
  }

  menu.push(fileMenu(opts.isMac, t));
  menu.push(editMenu(t));
  menu.push(viewMenu(t));
  menu.push(workspaceMenu(t));

  if (opts.isMac) {
    menu.push(windowMenu(t));
  }

  return enrichWithKeybindings(menu, opts.isMac, opts.bindings ?? KEYBINDINGS);
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
      { type: "separator" },
      // macOS convention: Settings… right under About, ⌘, accelerator.
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
    { type: "separator" },
    cmd(t != null ? t("menu:file.openFile") : "Open File…", COMMANDS.fileOpen),
    cmd(t != null ? t("menu:file.save") : "Save", COMMANDS.fileSave),
    { type: "separator" },
    cmd(t != null ? t("menu:file.closeEditor") : "Close Editor", COMMANDS.tabClose),
    cmd(t != null ? t("menu:file.closeOthers") : "Close Others", COMMANDS.tabCloseOthers),
    { type: "separator" },
    cmd(t != null ? t("menu:file.refreshFiles") : "Refresh Files", COMMANDS.filesRefresh),
  ];

  // Win/Linux don't get the App menu, so Quit (and Settings, which on
  // macOS lives in the App menu) live in File instead.
  if (!isMac) {
    items.push({ type: "separator" });
    items.push(cmd(t != null ? t("menu:appMenu.settings") : "Settings…", COMMANDS.settingsOpen));
    items.push({ type: "separator" });
    items.push({ type: "role", role: "quit", label: t != null ? t("menu:file.exit") : "Exit" });
  }

  return { type: "submenu", label: t != null ? t("menu:file.label") : "File", submenu: items };
}

function editMenu(t?: TFunction): MenuItemSpec {
  // The role-based Edit menu lets Chromium handle copy/paste/select-all
  // inside any focused input or contenteditable. Defining our own
  // command-based Edit items here would break Monaco's built-in
  // shortcuts (it expects the standard roles to flow through Cocoa).
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

function viewMenu(t?: TFunction): MenuItemSpec {
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
      { type: "separator" },
      cmd(t != null ? t("menu:view.revealInFinder") : "Reveal in Finder", COMMANDS.pathReveal),
      cmd(t != null ? t("menu:view.copyPath") : "Copy Path", COMMANDS.pathCopy),
      cmd(
        t != null ? t("menu:view.copyRelativePath") : "Copy Relative Path",
        COMMANDS.pathCopyRelative,
      ),
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

/**
 * Walk the spec tree and fill in `accelerator` (and the chord label
 * suffix) for each command item from the EFFECTIVE binding table
 * (defaults + user overrides). Pure over the spec — no Electron access
 * here.
 *
 * Mirrors VSCode's `withKeybinding` strategy:
 *   - Single-key binding → set `accelerator` (display only — every
 *     command item sets `registerAccelerator: false`).
 *   - Chord binding → no accelerator, append `[⌘K ⌘W]` to the label
 *     (Electron can't register chords; renderer dispatches them).
 *   - No binding (user unbound it) → bare label, no shortcut shown.
 */
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

    const primary = bindings.find((b) => b.command === spec.command && b.primary !== undefined);
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
