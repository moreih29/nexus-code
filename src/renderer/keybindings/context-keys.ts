import { isLinux, isMac, isWindows } from "../utils/platform";

type ContextProbe = () => boolean;

const dynamicProbes = new Map<string, ContextProbe>();

export function registerContextProbe(name: string, probe: ContextProbe): () => void {
  dynamicProbes.set(name, probe);
  return () => {
    if (dynamicProbes.get(name) === probe) dynamicProbes.delete(name);
  };
}

export function __resetContextProbesForTests(): void {
  dynamicProbes.clear();
}

export function evaluateContextKey(name: string, event: KeyboardEvent): boolean {
  const target = (event.target as HTMLElement | null) ?? null;
  switch (name) {
    case "editorFocus":
      return isInCodeEditor(target);
    case "inputFocus":
      return isInPlainInput(target);
    case "fileTreeFocus":
      return isInFileTree(target);
    case "terminalFocus":
      return isInTerminal(target);
    case "commandPaletteFocus":
      return isInCommandPalette(target);
    case "keybindingRecorderFocus":
      return isInKeybindingRecorder(target);
    case "isMac":
      return isMac();
    case "isLinux":
      return isLinux();
    case "isWindows":
      return isWindows();
    default: {
      const probe = dynamicProbes.get(name);
      if (probe !== undefined) {
        try {
          return probe();
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

function isInCodeEditor(target: HTMLElement | null): boolean {
  return closest(target, ".cm-editor") != null || closest(target, ".monaco-editor") != null;
}

function isInPlainInput(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (closest(target, ".cm-editor") != null) return false;
  if (closest(target, ".monaco-editor") != null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable === true) return true;
  return false;
}

function isInFileTree(target: HTMLElement | null): boolean {
  return closest(target, '[role="tree"]') != null;
}

function isInTerminal(target: HTMLElement | null): boolean {
  return closest(target, ".xterm") != null;
}

function isInCommandPalette(target: HTMLElement | null): boolean {
  return closest(target, "[data-command-palette-root]") != null;
}

function isInKeybindingRecorder(target: HTMLElement | null): boolean {
  return closest(target, "[data-keybinding-recorder]") != null;
}

function closest(target: HTMLElement | null, selector: string): Element | null {
  if (!target || typeof target.closest !== "function") return null;
  return target.closest(selector);
}
