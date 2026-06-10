import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { registerPaletteCommands } from "../../../../src/renderer/commands/domains/palette";
import {
  __resetCommandsForTests,
  executeCommand,
  registerCommand,
} from "../../../../src/renderer/commands/registry";
import {
  __resetWorkspaceSymbolPaletteStateForTests,
  isWorkspaceSymbolPaletteOpen,
} from "../../../../src/renderer/components/symbol-palette/workspace-symbol-palette-state";
import { evaluateContextKey } from "../../../../src/renderer/keybindings/context-keys";
import {
  __resetChordStateForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";
import { findPrimaryBinding } from "../../../../src/shared/keybindings/index";

interface MockEvent {
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  code: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function makeEvent(
  key: string,
  opts: {
    metaKey?: boolean;
    code?: string;
    target?: unknown;
  } = {},
): MockEvent {
  let prevented = false;
  return {
    key,
    code: opts.code ?? "",
    metaKey: opts.metaKey ?? false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    target: opts.target ?? null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

function paletteTarget(): HTMLElement {
  return {
    closest(selector: string) {
      return selector === "[data-command-palette-root]" ? ({} as HTMLElement) : null;
    },
  } as unknown as HTMLElement;
}

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  __resetWorkspaceSymbolPaletteStateForTests();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  __resetWorkspaceSymbolPaletteStateForTests();
});

describe("workspace symbol palette command/keybinding", () => {
  it("binds Cmd+T to the workspace symbol search command", () => {
    expect(findPrimaryBinding(COMMANDS.workspaceSymbolSearch)?.primary).toBe("CmdOrCtrl+Shift+O");
  });

  it("command registration opens the palette", () => {
    const unregister = registerPaletteCommands();

    executeCommand(COMMANDS.workspaceSymbolSearch);

    expect(isWorkspaceSymbolPaletteOpen()).toBe(true);
    for (const off of unregister) off();
  });

  it("Cmd+T dispatch opens the palette", () => {
    const unregister = registerPaletteCommands();
    let prevented = false;
    const e = {
      key: "O",
      code: "KeyO",
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      target: null,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    };

    handleGlobalKeyDown(e as unknown as KeyboardEvent);

    expect(e.defaultPrevented).toBe(true);
    expect(isWorkspaceSymbolPaletteOpen()).toBe(true);
    for (const off of unregister) off();
  });

  it("commandPaletteFocus prevents global command conflicts while the modal is focused", () => {
    const save = mock(() => {});
    registerCommand(COMMANDS.fileSave, save);
    const target = paletteTarget();
    const e = makeEvent("s", { metaKey: true, code: "KeyS", target });

    expect(evaluateContextKey("commandPaletteFocus", e as unknown as KeyboardEvent)).toBe(true);
    expect(handleGlobalKeyDown(e as unknown as KeyboardEvent)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
