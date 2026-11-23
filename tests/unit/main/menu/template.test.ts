import { describe, expect, it } from "bun:test";
import { buildMenuTemplate, type MenuItemSpec } from "../../../../src/main/features/menu/template";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

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

describe("buildMenuTemplate (mac)", () => {
  const specs = buildMenuTemplate({ platform: "darwin", appName: "Nexus" });

  it("binds Cmd+W to tab.close (overriding Electron default Close Window)", () => {
    const item = findCommand(specs, COMMANDS.tabClose);
    expect(item).toBeDefined();
    if (item?.type !== "command") throw new Error("unreachable");
    expect(item.accelerator).toBe("CmdOrCtrl+W");
    expect(item.label).toBe("Close Tab");
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

  it("reloads the window from the main process, with no key of its own", () => {
    const view = specs.find((s) => s.type === "submenu" && s.label === "View");
    if (view?.type !== "submenu") throw new Error("no View menu");
    expect(view.submenu).toContainEqual({
      type: "action",
      label: "Reload Window",
      action: "reloadWindow",
    });
  });

  it("adds no ⌘= zoom key (Cocoa would take it from Monaco's ⌘K ⌘= chord)", () => {
    const zoomIns = flatten(specs).filter((s) => s.type === "role" && s.role === "zoomIn");
    expect(zoomIns).toEqual([{ type: "role", role: "zoomIn" }]);
  });
});
