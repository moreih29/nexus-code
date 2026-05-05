/**
 * Pure tests for the Application Menu template.
 *
 * These guard the conflict-resolution we care about — Cmd+W must hit
 * `tab.close` (not Electron's default "Close Window"), Cmd+R must hit
 * `files.refresh` (not "Reload"), and Cmd+Shift+R must not exist.
 * Also pins Mac vs Win/Linux structural differences (App menu present
 * only on mac; Quit migrates into File on Win/Linux).
 */
import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../../src/shared/commands";
import { buildMenuTemplate, type MenuItemSpec } from "../../../../src/main/menu/template";

function flatten(specs: MenuItemSpec[]): MenuItemSpec[] {
  const out: MenuItemSpec[] = [];
  for (const s of specs) {
    out.push(s);
    if (s.type === "submenu") out.push(...flatten(s.submenu));
  }
  return out;
}

function findCommand(specs: MenuItemSpec[], command: string) {
  return flatten(specs).find((s) => s.type === "command" && s.command === command);
}

function topLabels(specs: MenuItemSpec[]): string[] {
  return specs.map((s) =>
    s.type === "submenu" ? s.label : s.type === "role" ? s.role : "(separator)",
  );
}

describe("buildMenuTemplate (mac)", () => {
  const specs = buildMenuTemplate({ isMac: true, appName: "Nexus" });

  it("starts with the App menu (role: appMenu) labeled with the app name", () => {
    const first = specs[0];
    expect(first.type).toBe("submenu");
    if (first.type !== "submenu") throw new Error("unreachable");
    expect(first.label).toBe("Nexus");
    expect(first.role).toBe("appMenu");
  });

  it("has the canonical top-level order: App / File / Edit / View / Workspace / Window", () => {
    expect(topLabels(specs)).toEqual(["Nexus", "File", "Edit", "View", "Workspace", "Window"]);
  });

  it("binds Cmd+W to tab.close (overriding Electron default Close Window)", () => {
    const item = findCommand(specs, COMMANDS.tabClose);
    expect(item).toBeDefined();
    if (item?.type !== "command") throw new Error("unreachable");
    expect(item.accelerator).toBe("CmdOrCtrl+W");
    expect(item.label).toBe("Close Editor");
  });

  it("binds Cmd+R to files.refresh (overriding Electron default Reload)", () => {
    const item = findCommand(specs, COMMANDS.filesRefresh);
    expect(item).toBeDefined();
    if (item?.type !== "command") throw new Error("unreachable");
    expect(item.accelerator).toBe("CmdOrCtrl+R");
  });

  it("does not surface Force Reload at Cmd+Shift+R", () => {
    const items = flatten(specs);
    const forceReload = items.find(
      (s) => s.type === "command" && s.accelerator === "CmdOrCtrl+Shift+R",
    );
    expect(forceReload).toBeUndefined();
  });

  it("keeps the role-based Edit menu (Chromium handles standard text edits)", () => {
    const edit = specs.find((s) => s.type === "submenu" && s.label === "Edit");
    expect(edit).toBeDefined();
    if (edit?.type !== "submenu") throw new Error("unreachable");
    expect(edit.role).toBe("editMenu");
    const roles = edit.submenu.filter((s) => s.type === "role").map((s) => (s as { role: string }).role);
    for (const r of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(roles).toContain(r);
    }
  });

  it("keeps DevTools and zoom roles in View", () => {
    const view = specs.find((s) => s.type === "submenu" && s.label === "View");
    if (view?.type !== "submenu") throw new Error("unreachable");
    const roles = view.submenu.filter((s) => s.type === "role").map((s) => (s as { role: string }).role);
    expect(roles).toContain("toggleDevTools");
    expect(roles).toContain("resetZoom");
    expect(roles).toContain("zoomIn");
    expect(roles).toContain("zoomOut");
    expect(roles).toContain("togglefullscreen");
  });

  it("path actions live under View with VSCode accelerators", () => {
    const reveal = findCommand(specs, COMMANDS.pathReveal);
    if (reveal?.type !== "command") throw new Error("unreachable");
    expect(reveal.accelerator).toBe("CmdOrCtrl+Alt+R");

    const copy = findCommand(specs, COMMANDS.pathCopy);
    if (copy?.type !== "command") throw new Error("unreachable");
    expect(copy.accelerator).toBe("CmdOrCtrl+Alt+C");

    const copyRel = findCommand(specs, COMMANDS.pathCopyRelative);
    if (copyRel?.type !== "command") throw new Error("unreachable");
    expect(copyRel.accelerator).toBe("CmdOrCtrl+Shift+Alt+C");
  });

  it("split / focus shortcuts live under Workspace", () => {
    const ws = specs.find((s) => s.type === "submenu" && s.label === "Workspace");
    if (ws?.type !== "submenu") throw new Error("unreachable");
    const cmds = ws.submenu.filter((s) => s.type === "command").map((s) => (s as { command: string }).command);
    expect(cmds).toContain(COMMANDS.groupSplitRight);
    expect(cmds).toContain(COMMANDS.groupSplitDown);
    expect(cmds).toContain(COMMANDS.groupClose);
    expect(cmds).toContain(COMMANDS.groupFocusLeft);
    expect(cmds).toContain(COMMANDS.groupFocusRight);
    expect(cmds).toContain(COMMANDS.groupFocusUp);
    expect(cmds).toContain(COMMANDS.groupFocusDown);
  });
});

describe("buildMenuTemplate (win/linux)", () => {
  const specs = buildMenuTemplate({ isMac: false, appName: "Nexus" });

  it("omits the App menu and the Window menu (no mac-specific roles)", () => {
    expect(topLabels(specs)).toEqual(["File", "Edit", "View", "Workspace"]);
  });

  it("places Quit/Exit inside File", () => {
    const file = specs[0];
    if (file.type !== "submenu") throw new Error("unreachable");
    const quit = file.submenu.find((s) => s.type === "role" && s.role === "quit");
    expect(quit).toBeDefined();
  });

  it("Cmd+W still hits tab.close on non-mac too", () => {
    const item = findCommand(specs, COMMANDS.tabClose);
    if (item?.type !== "command") throw new Error("unreachable");
    expect(item.accelerator).toBe("CmdOrCtrl+W");
  });
});
