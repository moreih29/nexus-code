import { create } from "zustand";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/renderer";
import type { CustomShell, ShellChoice } from "../../../shared/pty/shell";
import {
  asTaskAgent,
  DEFAULT_TASK_AGENT,
  type TaskAgent,
  taskAgentOfCommand,
} from "../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("terminal");

export type TerminalFontSize = number;
export type TerminalCursorStyle = "block" | "underline" | "bar";

interface TerminalSettingsState {
  fontSize: TerminalFontSize | undefined;
  cursorStyle: TerminalCursorStyle | undefined;
  fontFamily: string | undefined;
  fontLigatures: boolean | undefined;
  shell: ShellChoice | undefined;
  customShells: CustomShell[];
  taskAgent: TaskAgent | undefined;

  hydrate(values: {
    fontSize?: TerminalFontSize | undefined;
    cursorStyle?: TerminalCursorStyle | undefined;
    fontFamily?: string | undefined;
    fontLigatures?: boolean | undefined;
    shell?: ShellChoice | undefined;
    customShells?: CustomShell[] | undefined;
    taskAgent?: string | undefined;
    taskAgentCommand?: string | undefined;
  }): void;

  hydrateShells(shells: { shell?: ShellChoice | undefined; customShells: CustomShell[] }): void;

  setShell(value: ShellChoice | undefined): void;

  saveCustomShell(shell: CustomShell): void;

  removeCustomShell(id: string): void;

  setFontSize(value: TerminalFontSize | undefined): void;

  setCursorStyle(value: TerminalCursorStyle | undefined): void;

  setFontFamily(value: string | undefined): void;

  setFontLigatures(value: boolean | undefined): void;

  setTaskAgent(value: TaskAgent | undefined): void;
}

function dispatchSettingsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nexus:terminal-settings-changed"));
  }
}

export const useTerminalStore = create<TerminalSettingsState>((set, get) => {
  const setCustomShells = (list: CustomShell[]) => {
    set({ customShells: list });

    void ipcCallResult("appState", "set", {
      terminalShells: list.length > 0 ? list : undefined,
    }).then((result) => {
      if (!result.ok) log.warn(`appState set (customShells) failed: ${result.message}`);
    });
  };

  return {
    fontSize: undefined,
    cursorStyle: undefined,
    fontFamily: undefined,
    fontLigatures: undefined,
    shell: undefined,
    customShells: [],
    taskAgent: undefined,

    hydrate({
      fontSize,
      cursorStyle,
      fontFamily: family,
      fontLigatures,
      shell,
      customShells,
      taskAgent,
      taskAgentCommand,
    }) {
      let agent = asTaskAgent(taskAgent);
      if (taskAgent === undefined && taskAgentCommand !== undefined) {
        const carried = taskAgentOfCommand(taskAgentCommand);
        agent = carried === DEFAULT_TASK_AGENT ? undefined : carried;
        void ipcCallResult("appState", "set", {
          taskAgent: agent,
          taskAgentCommand: undefined,
        }).then((result) => {
          if (!result.ok) log.warn(`appState set (taskAgent) failed: ${result.message}`);
        });
      }
      set({
        fontSize,
        cursorStyle,
        fontFamily: family,
        fontLigatures,
        shell,
        customShells: customShells ?? [],
        taskAgent: agent,
      });
    },

    hydrateShells({ shell, customShells }) {
      set({ shell, customShells });
    },

    setShell(value) {
      set({ shell: value });

      void ipcCallResult("appState", "set", {
        terminalShell: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (shell) failed: ${result.message}`);
      });
    },

    saveCustomShell(shell) {
      const list = get().customShells;
      setCustomShells(
        list.some((s) => s.id === shell.id)
          ? list.map((s) => (s.id === shell.id ? shell : s))
          : [...list, shell],
      );
    },

    removeCustomShell(id) {
      setCustomShells(get().customShells.filter((s) => s.id !== id));
      const { shell, setShell } = get();
      if (shell?.kind === "custom" && shell.id === id) setShell(undefined);
    },

    setFontSize(value) {
      set({ fontSize: value });

      void ipcCallResult("appState", "set", {
        terminalFontSize: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontSize) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setCursorStyle(value) {
      set({ cursorStyle: value });

      void ipcCallResult("appState", "set", {
        terminalCursorStyle: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (cursorStyle) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setFontFamily(value) {
      set({ fontFamily: value });

      void ipcCallResult("appState", "set", {
        terminalFontFamily: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontFamily) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setFontLigatures(value) {
      set({ fontLigatures: value });

      void ipcCallResult("appState", "set", {
        terminalFontLigatures: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontLigatures) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setTaskAgent(value) {
      set({ taskAgent: value });

      void ipcCallResult("appState", "set", {
        taskAgent: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (taskAgent) failed: ${result.message}`);
      });
    },
  };
});

export const DEFAULT_TERMINAL_FONT_SIZE: number = typeScale.codeUi.fontSize;

export function resolvedTerminalFontSize(): number {
  const { fontSize } = useTerminalStore.getState();
  return fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
}

export function resolvedTerminalCursorStyle(): TerminalCursorStyle {
  const { cursorStyle } = useTerminalStore.getState();
  return cursorStyle ?? "block";
}

export function resolvedTerminalFontFamily(): string {
  const { fontFamily: family } = useTerminalStore.getState();
  if (family && family.trim() !== "") {
    return `"${family}", ${fontFamily.monoDisplay}`;
  }
  return fontFamily.monoDisplay;
}

export function resolvedTaskAgent(): TaskAgent {
  return useTerminalStore.getState().taskAgent ?? DEFAULT_TASK_AGENT;
}

export function resolvedTerminalFontLigatures(): boolean {
  const { fontLigatures } = useTerminalStore.getState();
  return fontLigatures ?? false;
}
