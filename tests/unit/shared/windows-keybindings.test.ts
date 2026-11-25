import { describe, expect, it } from "bun:test";
import { detectConflicts } from "../../../src/shared/keybindings/conflicts";
import { KEYBINDINGS } from "../../../src/shared/keybindings/index";
import {
  acceleratorToLabel,
  eventToAccelerator,
  namesSuperKey,
  normalizeKeystroke,
  recordedAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { findReservedKey, RESERVED_KEYS } from "../../../src/shared/keybindings/reserved-keys";

const systemConflict = (primary: string, isMac: boolean, isWindows: boolean) =>
  detectConflicts({ command: "test.action", primary, bindings: [], isMac, isWindows }).find(
    ({ kind }) => kind === "system",
  );

function keyEvent(code: string, mods: Partial<Record<"meta" | "ctrl" | "shift" | "alt", boolean>>) {
  return {
    code,
    metaKey: mods.meta === true,
    ctrlKey: mods.ctrl === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
  } as KeyboardEvent;
}

describe("macOS reserved keys stay as they were", () => {
  it("keeps the same four macOS system keys", () => {
    expect(RESERVED_KEYS.filter((r) => r.platform === "mac")).toEqual([
      { accelerator: "Cmd+Q", source: "system", noteKey: "quitApplication", platform: "mac" },
      { accelerator: "Cmd+H", source: "system", noteKey: "hideApplication", platform: "mac" },
      { accelerator: "Cmd+Alt+H", source: "system", noteKey: "hideOthers", platform: "mac" },
      { accelerator: "Cmd+M", source: "system", noteKey: "minimizeWindow", platform: "mac" },
    ]);
  });

  it("reserves them on macOS only, and none of the Windows keys there", () => {
    for (const key of ["Cmd+Q", "Cmd+H", "Cmd+Alt+H", "Cmd+M"]) {
      expect(systemConflict(key, true, false)?.reserved?.platform).toBe("mac");
      expect(systemConflict(key, true, true)?.reserved?.platform).toBe("mac");
      expect(systemConflict(key, false, true)).toBeUndefined();
    }
    for (const key of ["Alt+F4", "Ctrl+Alt+Delete", "Alt+Tab", "Ctrl+Escape", "Alt+Space"]) {
      expect(systemConflict(key, true, false)).toBeUndefined();
      expect(systemConflict(key, true, true)).toBeUndefined();
    }
  });

  it("records keys on macOS as before", () => {
    expect(eventToAccelerator(keyEvent("KeyY", { meta: true }), true)).toBe("CmdOrCtrl+Y");
    expect(eventToAccelerator(keyEvent("KeyY", { meta: true, ctrl: true }), true)).toBe(
      "Cmd+Ctrl+Y",
    );
    expect(eventToAccelerator(keyEvent("KeyY", { ctrl: true }), true)).toBe("Ctrl+Y");
  });
});

describe("Windows system keys", () => {
  it("are reserved by the OS on Windows, as macOS system keys are on macOS", () => {
    for (const [key, noteKey] of [
      ["Alt+F4", "closeWindow"],
      ["Ctrl+Alt+Delete", "securityScreen"],
      ["CmdOrCtrl+Alt+Delete", "securityScreen"],
      ["Ctrl+Shift+Escape", "taskManager"],
      ["Alt+Tab", "switchWindows"],
      ["Shift+Alt+Tab", "switchWindowsBack"],
      ["Alt+Escape", "cycleWindows"],
      ["Ctrl+Escape", "startMenu"],
      ["Alt+Space", "windowMenu"],
    ] as const) {
      expect(systemConflict(key, false, true)?.reserved?.noteKey).toBe(noteKey);
      expect(systemConflict(key, false, false)).toBeUndefined();
    }
    expect(findReservedKey("Alt+F4", false)).toBeUndefined();
  });
});

describe("keys as the Settings page records them on Windows and Linux", () => {
  it("is what the recorder makes from the same keystroke", () => {
    const pressed = [
      ["Ctrl+Y", keyEvent("KeyY", { ctrl: true })],
      ["Shift+Alt+F4", keyEvent("F4", { shift: true, alt: true })],
      ["Control+Shift+.", keyEvent("Period", { ctrl: true, shift: true })],
      ["Ctrl+Alt+Left", keyEvent("ArrowLeft", { ctrl: true, alt: true })],
    ] as const;
    for (const [typed, event] of pressed) {
      expect(recordedAccelerator(typed, false)).toBe(eventToAccelerator(event, false));
    }
  });

  it("reads Cmd and Meta as Ctrl, and can't record Cmd+Ctrl, as the recorder can't", () => {
    expect(recordedAccelerator("Meta+Y", false)).toBe("CmdOrCtrl+Y");
    expect(recordedAccelerator("Cmd+Shift+Y", false)).toBe("CmdOrCtrl+Shift+Y");
    expect(recordedAccelerator("Ctrl+F4", false)).toBe("CmdOrCtrl+F4");
    expect(recordedAccelerator("Cmd+Ctrl+Y", false)).toBeNull();
    expect(eventToAccelerator(keyEvent("KeyY", { meta: true, ctrl: true }), false)).toBeNull();
    expect(recordedAccelerator("Hyper+Y", false)).toBeNull();
  });

  it("names the Windows or Super key", () => {
    for (const key of ["Win+Y", "super+Shift+Y", "Windows+D"])
      expect(namesSuperKey(key)).toBe(true);
    for (const key of ["Meta+Y", "CmdOrCtrl+W", "Alt+Tab"]) expect(namesSuperKey(key)).toBe(false);
  });

  it("takes back every default as its label shows it, but for the Windows-key ones", () => {
    const primaries = KEYBINDINGS.flatMap((b) => (b.primary ? [b.primary] : []));
    const superKeyLabels: string[] = [];
    for (const primary of primaries) {
      const label = acceleratorToLabel(primary, { isMac: false, platform: "win32" });
      if (namesSuperKey(label)) {
        superKeyLabels.push(label);
        continue;
      }
      const recorded = recordedAccelerator(label, false);
      expect(recorded).not.toBeNull();
      expect(normalizeKeystroke(recorded as string, false)).toBe(
        normalizeKeystroke(primary, false),
      );
    }
    expect(superKeyLabels).toEqual([
      "Win+Ctrl+Left",
      "Win+Ctrl+Right",
      "Win+Ctrl+Up",
      "Win+Ctrl+Down",
    ]);
  });
});
