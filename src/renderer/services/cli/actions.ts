/**
 * What the nexus CLI changes in the renderer: it opens editors, diffs,
 * terminals and browser tabs, types into terminals, shows and closes tabs,
 * switches workspaces, and makes and removes tasks.
 *
 * A tab the CLI opens is not focused: the user may be typing in the
 * terminal the command came from. Where it goes is ./placement's call.
 */

import i18next from "i18next";
import { askCliConsent } from "@/components/cli/consent-dialog";
import { EMPTY_TREE } from "@/components/editor/diff-refs";
import { ipcCallResult } from "@/ipc/client";
import { holdsUnsavedChanges } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { useGitStore } from "@/state/stores/git";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { useTerminalStore } from "@/state/stores/terminal";
import { tasksOf, useWorkspacesStore } from "@/state/stores/workspaces";
import type { CliUiOp } from "../../../shared/cli/ui";
import { type ShellChoice, sameShellChoice } from "../../../shared/pty/shell";
import { untitledCacheUriFor } from "../../../shared/fs/workspace-uri";
import { classifyUrl } from "../browser/url-classifier";
import { isDirty } from "../editor/model/dirty-tracker";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { countUnsavedBuffers } from "../editor/save/unsaved-guard";
import { requestEditorReveal } from "../editor/tabs/pending-reveal";
import { runningProgram } from "../terminal/close-confirm";
import {
  loadInstalledShells,
  type ShellEntry,
  shellEntries,
  shellNamed,
} from "../terminal/installed-shells";
import { closeTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { getTerminalController } from "../terminal/terminal-registry";
import { activateWorkspace, removeTask, startTask } from "../workspace/tasks";
import { type CliUiHandler, UiRequestError } from "./handler";
import type { LayoutOp } from "./layout-actions";
import { findTabs, groupOf, openTab, showOpenTab } from "./placement";

export { type CliUiHandler, UiRequestError } from "./handler";

/**
 * How long Enter waits after pasted text. Sent with the paste, it can reach
 * an agent's prompt inside the same read and be taken as part of the paste.
 */
const ENTER_DELAY_MS = 120;

function terminalController(tabId: string) {
  const controller = getTerminalController(tabId);
  if (!controller) {
    throw new UiRequestError(
      "that terminal has not started: its workspace has not been opened since NexusCode started",
    );
  }
  return controller;
}

export function tabRecord(workspaceId: string, tabId: string): Tab {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) throw new UiRequestError("that tab is gone");
  return tab;
}

function navigableUrl(input: string): string {
  const result = classifyUrl(input);
  if (result.kind === "navigate") return result.url;
  throw new UiRequestError(
    result.kind === "blocked" ? (result.error ?? `cannot open ${input}`) : `not a URL: ${input}`,
  );
}

export function hasUnsavedChanges(workspaceId: string, tab: Tab): boolean {
  if (tab.type === "untitled") {
    return isDirty(untitledCacheUriFor(workspaceId, tab.props.untitledIndex));
  }
  return holdsUnsavedChanges(tab);
}

async function callOrFail(result: Promise<{ ok: boolean; message?: string }>): Promise<void> {
  const settled = await result;
  if (!settled.ok) throw new UiRequestError(settled.message ?? "the app refused");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const actionHandlers: {
  [K in Exclude<
    CliUiOp,
    "tabs.list" | "terminal.read" | "settings.list" | "settings.set" | LayoutOp
  >]: CliUiHandler<K>;
} = {
  "editor.open": async ({ workspaceId, filePath, line, column, placement }) => {
    const open = findTabs(
      workspaceId,
      (tab) => tab.type === "editor" && tab.props.filePath === filePath,
    );
    const tabId =
      showOpenTab(workspaceId, open, placement) ??
      openTab(workspaceId, { type: "editor", props: { workspaceId, filePath } }, placement);
    if (line !== undefined) {
      const at = { lineNumber: line, column: column ?? 1 };
      requestEditorReveal({
        workspaceId,
        filePath,
        tabId,
        range: {
          startLineNumber: at.lineNumber,
          startColumn: at.column,
          endLineNumber: at.lineNumber,
          endColumn: at.column,
        },
      });
    }
    return { tabId };
  },

  "diff.open": async ({ workspaceId, relPath, leftRef, rightRef, placement }) => {
    const unborn =
      useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
    const left = unborn && leftRef === "HEAD" ? EMPTY_TREE : leftRef;
    const open = findTabs(
      workspaceId,
      (tab) =>
        tab.type === "editor.diff" &&
        tab.props.relPath === relPath &&
        tab.props.leftRef === left &&
        tab.props.rightRef === rightRef &&
        tab.props.oldRelPath === undefined,
    );
    const props = { workspaceId, relPath, leftRef: left, rightRef };
    const tabId =
      showOpenTab(workspaceId, open, placement) ??
      openTab(workspaceId, { type: "editor.diff", props }, placement);
    return { tabId };
  },

  "terminal.open": async ({ workspaceId, cwd, title, command, shell, placement }) => {
    const choice = shell === undefined ? undefined : (await shellByName(shell)).choice;
    const props = { cwd, ...(choice ? { shell: choice } : {}) };
    const tabId = openTab(workspaceId, { type: "terminal", props }, placement);
    if (title) useTabsStore.getState().renameTab(workspaceId, tabId, title);
    if (command) queueStartupInput(workspaceId, tabId, () => `${command}\r`);
    return { tabId };
  },

  "terminal.shells": async () => {
    const { entries, defaultShell } = await shellMenu();
    return {
      shells: entries.map((entry) => ({
        name: entry.name,
        kind: entry.choice.kind,
        id: entry.choice.id,
        path: entry.path,
        isDefault: sameShellChoice(entry.choice, defaultShell),
      })),
    };
  },

  "terminal.input": async ({ tabId, text, mode, enter }) => {
    const controller = terminalController(tabId);
    if (text !== "" && !controller.input(text, mode)) {
      throw new UiRequestError("that terminal has not opened yet");
    }
    if (enter) {
      if (text !== "") await sleep(ENTER_DELAY_MS);
      controller.input("\r", "keys");
    }
    return {};
  },

  "tab.show": async ({ workspaceId, tabId }) => {
    const groupId = groupOf(workspaceId, tabId);
    if (!groupId) throw new UiRequestError("that tab is gone");
    if (useActiveStore.getState().activeWorkspaceId !== workspaceId) {
      activateWorkspace(workspaceId);
    }
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
    return {};
  },

  "tab.close": async ({ workspaceId, tabId, force }) => {
    const tab = tabRecord(workspaceId, tabId);
    if (tab.type === "terminal") {
      if (!force && !tab.props.dead) {
        const program = await runningProgram(workspaceId, tabId);
        if (program !== null) {
          throw new UiRequestError(`${program} is running there; add --force to close it anyway`);
        }
      }
      closeTerminal(tabId);
      return {};
    }
    if (hasUnsavedChanges(workspaceId, tab)) {
      throw new UiRequestError("it has unsaved changes; save or close it in the app");
    }
    await closeTabWithConfirm(workspaceId, tabId);
    return {};
  },

  "browser.open": async ({ workspaceId, url, placement }) => {
    const target = navigableUrl(url);
    const tabId = openTab(
      workspaceId,
      {
        type: "browser",
        props: {
          initialUrl: target,
          lastUrl: target,
          partition: `persist:browser-${workspaceId}`,
        },
      },
      placement,
    );
    return { tabId, url: target };
  },

  "browser.navigate": async ({ workspaceId, tabId, action, url }) => {
    const tab = tabRecord(workspaceId, tabId);
    if (tab.type !== "browser") throw new UiRequestError("that tab is not a browser");
    const runtime = useBrowserRuntimeStore.getState().runtimes.get(tabId);
    if (action === "goto") {
      const target = navigableUrl(url ?? "");
      if (runtime) await callOrFail(ipcCallResult("browser", "navigate", { tabId, url: target }));
      else useTabsStore.getState().setBrowserLastUrl(workspaceId, tabId, target);
      return { url: target };
    }
    if (!runtime) {
      throw new UiRequestError(
        "that browser has not loaded: its workspace has not been opened since NexusCode started",
      );
    }
    if (action === "back") await callOrFail(ipcCallResult("browser", "goBack", { tabId }));
    else if (action === "forward") {
      await callOrFail(ipcCallResult("browser", "goForward", { tabId }));
    } else await callOrFail(ipcCallResult("browser", "reload", { tabId }));
    return {};
  },

  "workspace.show": async ({ workspaceId }) => {
    activateWorkspace(workspaceId);
    return {};
  },

  "task.create": async ({ parentId, name, prompt, command, show, createdBy }) => {
    const started = await startTask(parentId, name, prompt, command, createdBy);
    if (!("task" in started)) throw new UiRequestError(started.message);
    // Its terminal starts once its panel is mounted, shown or not.
    if (show) activateWorkspace(started.task.id);
    else useMountedWorkspacesStore.getState().mount(started.task.id);
    return { workspaceId: started.task.id, tabId: started.tabId, command: started.command };
  },

  "task.remove": async ({ taskId, force, deleteBranch }) => {
    const unsaved = countUnsavedBuffers(taskId);
    if (unsaved > 0) {
      throw new UiRequestError(
        `it has ${unsaved} unsaved file${unsaved === 1 ? "" : "s"}; save or close them in the app`,
      );
    }
    const failure = await removeTask(taskId, { force, deleteBranch });
    if (failure?.kind === "worktree-dirty") {
      throw new UiRequestError(
        "its worktree has uncommitted changes; add --force to throw them away",
      );
    }
    if (failure) throw new UiRequestError(failure.message);
    return {};
  },

  "workspace.remove": async ({ workspaceId }) => {
    const tasks = tasksOf(useWorkspacesStore.getState().workspaces, workspaceId);
    const unsaved = [workspaceId, ...tasks.map((task) => task.id)].reduce(
      (sum, id) => sum + countUnsavedBuffers(id),
      0,
    );
    if (unsaved > 0) {
      throw new UiRequestError(
        `it has ${unsaved} unsaved file${unsaved === 1 ? "" : "s"}; save or close them in the app`,
      );
    }
    await callOrFail(ipcCallResult("workspace", "remove", { id: workspaceId }));
    return {};
  },

  "consent.ask": async ({ fromWorkspaceId, fromTabId, toWorkspaceId, change, timeoutMs }) => {
    const workspaces = useWorkspacesStore.getState().workspaces;
    const name = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id.slice(0, 8);
    const fromTab = useTabsStore.getState().byWorkspace[fromWorkspaceId]?.[fromTabId];
    const answer = await askCliConsent({
      fromWorkspace: name(fromWorkspaceId),
      fromTab: fromTab?.title ?? fromTabId.slice(0, 8),
      toWorkspace: name(toWorkspaceId),
      change,
      timeoutMs,
    });
    return { answer };
  },
};

/** The shells "New terminal with" lists, and the one a new terminal runs. */
async function shellMenu(): Promise<{ entries: ShellEntry[]; defaultShell: ShellChoice }> {
  const installed = await loadInstalledShells();
  const { customShells, shell } = useTerminalStore.getState();
  return {
    entries: shellEntries(i18next.t, installed, customShells),
    defaultShell: shell ?? { kind: "detected", id: installed.systemDefault.id },
  };
}

/** The shell `name` picks, or an error that lists the names to pick from. */
async function shellByName(name: string): Promise<ShellEntry> {
  const { entries } = await shellMenu();
  const entry = shellNamed(entries, name);
  if (entry) return entry;
  const names = entries.map((e) => e.name).join(", ");
  throw new UiRequestError(`no shell is named "${name}"; this machine has ${names}`);
}
