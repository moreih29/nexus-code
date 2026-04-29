import { createStore } from "zustand/vanilla";

export type CommandGroup = "Workspace" | "View" | "Editor" | "Terminal" | "Search" | "App";

export interface Command {
  group: CommandGroup;
  hidden?: boolean;
  id: string;
  keywords?: readonly string[];
  run: () => Promise<void> | void;
  title: string;
}

export interface KeyboardShortcutEventLike {
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  which?: number;
}

export interface KeyboardRegistryState {
  bindings: Record<string, string>;
  commands: Record<string, Command>;
  executeCommand(id: string): Promise<void>;
  getBindingFor(id: string): string | null;
  getCommands(): Command[];
  registerBinding(keychord: string, commandId: string): void;
  registerCommand(command: Command): void;
}

export const keyboardRegistryStore = createStore<KeyboardRegistryState>((set, get) => ({
  bindings: {},
  commands: {},
  async executeCommand(id) {
    const command = get().commands[id];

    if (!command) {
      console.warn(`Keyboard registry: command not found: ${id}`);
      return;
    }

    await command.run();
  },
  getBindingFor(id) {
    const entry = Object.entries(get().bindings).find(([, commandId]) => commandId === id);
    return entry?.[0] ?? null;
  },
  getCommands() {
    return Object.values(get().commands).filter((command) => !command.hidden);
  },
  registerBinding(keychord, commandId) {
    const normalizedKeychord = normalizeKeychord(keychord);
    const existingCommandId = get().bindings[normalizedKeychord];

    if (existingCommandId && existingCommandId !== commandId) {
      console.warn(
        `Keyboard registry: binding conflict for ${normalizedKeychord}; replacing ${existingCommandId} with ${commandId}.`,
      );
    }

    set((state) => ({
      bindings: {
        ...state.bindings,
        [normalizedKeychord]: commandId,
      },
    }));
  },
  registerCommand(command) {
    set((state) => ({
      commands: {
        ...state.commands,
        [command.id]: command,
      },
    }));
  },
}));

export function normalizeKeychord(keychord: string): string {
  const parts = keychord.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.at(-1);

  if (!key) {
    return keychord;
  }

  const modifierSet = new Set(parts.slice(0, -1).map(normalizeModifier));
  const normalizedParts = ["Cmd", "Ctrl", "Alt", "Shift"].filter((modifier) => modifierSet.has(modifier));
  normalizedParts.push(normalizeKey(key));
  return normalizedParts.join("+");
}

export function getKeychordFromKeyboardEvent(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.metaKey) {
    parts.push("Cmd");
  }

  if (event.ctrlKey) {
    parts.push("Ctrl");
  }

  if (event.altKey) {
    parts.push("Alt");
  }

  if (event.shiftKey) {
    parts.push("Shift");
  }

  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

export function shouldIgnoreKeyboardShortcut(event: KeyboardShortcutEventLike): boolean {
  return (
    event.isComposing === true ||
    event.key === "Process" ||
    event.keyCode === 229 ||
    event.which === 229
  );
}

export function shouldAllowSingleKeyInput(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }

  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

function normalizeModifier(modifier: string): string {
  const lowerModifier = modifier.toLowerCase();

  if (lowerModifier === "cmd" || lowerModifier === "command" || lowerModifier === "meta") {
    return "Cmd";
  }

  if (lowerModifier === "ctrl" || lowerModifier === "control") {
    return "Ctrl";
  }

  if (lowerModifier === "alt" || lowerModifier === "option") {
    return "Alt";
  }

  if (lowerModifier === "shift") {
    return "Shift";
  }

  return modifier;
}

function normalizeKey(key: string): string {
  if (key === "←") {
    return "ArrowLeft";
  }

  if (key === "→") {
    return "ArrowRight";
  }

  if (key === "↑") {
    return "ArrowUp";
  }

  if (key === "↓") {
    return "ArrowDown";
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }

  return key;
}
