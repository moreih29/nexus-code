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
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { useGitStore } from "@/state/stores/git";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { resolvedTaskAgent, useTerminalStore } from "@/state/stores/terminal";
import { tasksOf, useWorkspacesStore } from "@/state/stores/workspaces";
import type { CliUiOp } from "../../../shared/cli/ui";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import { type ShellChoice, sameShellChoice } from "../../../shared/pty/shell";
import { untitledCacheUriFor } from "../../../shared/fs/workspace-uri";
import { holdsInAgentView, showBesideCaller } from "../agent-view/show";
import { classifyUrl } from "../browser/url-classifier";
import { reloadModelFromDisk } from "../editor/model/cache";
import { isDirty } from "../editor/model/dirty-tracker";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { saveModel } from "../editor/save/service";
import { countUnsavedBuffers } from "../editor/save/unsaved-guard";
import { workingFileOfDiff } from "../editor/tabs/diff-working-file";
import { requestEditorReveal } from "../editor/tabs/pending-reveal";
import type { EditorInput } from "../editor/types";
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
import { activateWorkspace, removeTask, startTask, taskStartOf } from "../workspace/tasks";
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

/** The file an editor tab, or a diff tab's working-tree side, edits. */
function fileOfTab(workspaceId: string, tab: Tab): EditorInput {
  if (tab.type === "editor") return tab.props;
  if (tab.type === "editor.diff") {
    const filePath = workingFileOfDiff(tab.props);
    if (filePath !== null) return { workspaceId, filePath };
    throw new UiRequestError("that diff shows no working-tree file, so it has nothing to save");
  }
  if (tab.type === "untitled") {
    throw new UiRequestError("it has no file yet; save it in the app to name one");
  }
  throw new UiRequestError("only an editor or a diff has a file to save");
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
    | "tabs.list"
    | "terminal.read"
    | "events.read"
    | "settings.list"
    | "settings.set"
    | "manager.dispatched"
    | LayoutOp
    | `chat.${string}`
    | `agentView.${string}`
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
        preserveFocus: true,
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

  "commit.open": async ({ workspaceId, rev, placement }) => {
    // `^{commit}` takes a tag to the commit it names, which is what the tab shows.
    const found = await ipcCallResult("git", "commitDetail", {
      workspaceId,
      sha: `${rev}^{commit}`,
    });
    if (!found.ok) {
      throw new UiRequestError(
        /unknown revision|bad revision|ambiguous argument|not a valid|bad object/i.test(
          found.message ?? "",
        )
          ? `no commit is named "${rev}"`
          : (found.message ?? "the commit could not be read"),
      );
    }
    const { sha, subject } = found.value;
    const open = findTabs(workspaceId, (tab) => tab.type === "git.commit" && tab.props.sha === sha);
    const tabId =
      showOpenTab(workspaceId, open, placement) ??
      openTab(workspaceId, { type: "git.commit", props: { workspaceId, sha } }, placement);
    return { tabId, sha, subject };
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

  "tab.show": async ({ workspaceId, tabId, caller }) => {
    const groupId = groupOf(workspaceId, tabId);
    if (!groupId) throw new UiRequestError("that tab is gone");
    // A session shows in the agent view while it is up; anything else
    // leaves it for its workspace.
    if (isAgentViewShown() && holdsInAgentView(tabRecord(workspaceId, tabId).type)) {
      showBesideCaller(workspaceId, tabId, caller ?? null);
      return {};
    }
    // The tab first: switching to the workspace then lands on it.
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId, groupId, tabId });
    if (useActiveStore.getState().activeWorkspaceId !== workspaceId) {
      activateWorkspace(workspaceId);
    } else {
      useAgentViewStore.getState().setMode("workspace");
    }
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

  "tab.save": async ({ workspaceId, tabId }) => {
    const input = fileOfTab(workspaceId, tabRecord(workspaceId, tabId));
    const result = await saveModel(input);
    switch (result.kind) {
      case "saved":
      case "not-dirty":
        return { filePath: input.filePath, saved: result.kind === "saved" };
      case "no-model":
        // Not loaded since the app started: nothing typed in it to save.
        return { filePath: input.filePath, saved: false };
      case "conflict":
        throw new UiRequestError(
          'the file changed on disk since it was opened; saving it in the app lets the user choose which to keep, and "nexus tab revert" takes what is on disk',
        );
      case "read-only":
        throw new UiRequestError("it is read-only");
      case "superseded":
        throw new UiRequestError("another save of it started first; try again");
      case "error":
        throw new UiRequestError(`it could not be saved: ${result.message}`);
    }
  },

  "tab.revert": async ({ workspaceId, tabId }) => {
    const tab = tabRecord(workspaceId, tabId);
    const input = fileOfTab(workspaceId, tab);
    if (!hasUnsavedChanges(workspaceId, tab)) return { filePath: input.filePath, reverted: false };
    await reloadModelFromDisk(input);
    return { filePath: input.filePath, reverted: !hasUnsavedChanges(workspaceId, tab) };
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

  "task.create": async ({ parentId, name, prompt, start, show, createdBy }) => {
    const how = start ?? taskStartOf(resolvedTaskAgent());
    const started = await startTask(parentId, name, prompt, how, createdBy);
    if (!("task" in started)) throw new UiRequestError(started.message);
    // A terminal starts once its panel is mounted, shown or not. Shown while
    // the agent view is up, its agent shows there, beside the one asking.
    const tab = useTabsStore.getState().byWorkspace[started.task.id]?.[started.tabId];
    if (show && isAgentViewShown() && tab && holdsInAgentView(tab.type)) {
      showBesideCaller(started.task.id, started.tabId, createdBy);
    } else if (show) activateWorkspace(started.task.id);
    else useMountedWorkspacesStore.getState().mount(started.task.id);
    return { workspaceId: started.task.id, tabId: started.tabId, start: started.start };
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
      fromManager: isManagerWorkspace(fromWorkspaceId),
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
