import { afterEach, describe, expect, test } from "bun:test";

import { keyboardRegistryStore, normalizeKeychord } from "./keyboard-registry";

afterEach(() => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
});

describe("keyboardRegistryStore", () => {
  test("registers and executes commands", async () => {
    let count = 0;

    keyboardRegistryStore.getState().registerCommand({
      group: "App",
      id: "app.test",
      run: () => {
        count += 1;
      },
      title: "Test command",
    });

    await keyboardRegistryStore.getState().executeCommand("app.test");

    expect(count).toBe(1);
  });

  test("registers bindings and resolves command shortcuts", () => {
    keyboardRegistryStore.getState().registerCommand({
      group: "View",
      id: "view.toggleSidebar",
      run: () => {},
      title: "Toggle Sidebar",
    });
    keyboardRegistryStore.getState().registerBinding("cmd+b", "view.toggleSidebar");

    expect(keyboardRegistryStore.getState().bindings["Cmd+B"]).toBe("view.toggleSidebar");
    expect(keyboardRegistryStore.getState().getBindingFor("view.toggleSidebar")).toBe("Cmd+B");
  });

  test("warns and overwrites on binding conflicts", () => {
    const originalWarn = console.warn;
    let warnCount = 0;
    console.warn = () => {
      warnCount += 1;
    };

    try {
      keyboardRegistryStore.getState().registerBinding("Cmd+B", "view.toggleSidebar");
      keyboardRegistryStore.getState().registerBinding("Cmd+B", "view.toggleOther");

      expect(keyboardRegistryStore.getState().bindings["Cmd+B"]).toBe("view.toggleOther");
      expect(warnCount).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("normalizes modifier order and key casing", () => {
    expect(normalizeKeychord("shift+cmd+p")).toBe("Cmd+Shift+P");
    expect(normalizeKeychord("Ctrl+`")).toBe("Ctrl+`");
  });
});
