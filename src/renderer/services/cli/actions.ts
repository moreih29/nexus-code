import { askCliConsent, settleCliConsent } from "@/components/cli/consent-dialog";
import { EMPTY_TREE } from "@/components/editor/diff-refs";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { holdsUnsavedChanges, openNewUntitledTab } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { useAgentProfilesStore } from "@/state/stores/agent-profiles";
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { useBrowserPermissionsStore } from "@/state/stores/browser-permissions";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { useClaudeStatusStore } from "@/state/stores/claude-status";
import { useGitStore } from "@/state/stores/git";
import { useLayoutStore } from "@/state/stores/layout/store";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { resolvedTaskAgent } from "@/state/stores/terminal";
import { tasksOf, useWorkspacesStore } from "@/state/stores/workspaces";
import { hasProfile, PROFILE_AGENTS } from "../../../shared/agent-profiles/profiles";
import type { CliUiOp } from "../../../shared/cli/ui";
import { untitledCacheUriFor } from "../../../shared/fs/workspace-uri";
import { sameShellChoice } from "../../../shared/pty/shell";
import { shortId } from "../../../shared/util/short-id";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { holdsInAgentView, showBesideCaller } from "../agent-view/show";
import { classifyUrl } from "../browser/url-classifier";
import { existingChatController } from "../chat/claude/controller";
import { TEXT_ENCODINGS } from "../editor/encoding/text-encoding";
import { getResolvedModel, reloadModelFromDisk } from "../editor/model/cache";
import { isDirty } from "../editor/model/dirty-tracker";
import { isPreviewable } from "../editor/preview/previewable";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { saveModel } from "../editor/save/service";
import { countUnsavedBuffers } from "../editor/save/unsaved-guard";
import { workingFileOfDiff } from "../editor/tabs/diff-working-file";
import { requestEditorReveal } from "../editor/tabs/pending-reveal";
import type { EditorInput } from "../editor/types";
import { runningProgram } from "../terminal/close-confirm";
import { loadShellMenu, type ShellEntry, shellNamed } from "../terminal/installed-shells";
import { closeTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { getTerminalController, whenTerminalController } from "../terminal/terminal-registry";
import type { TerminalController } from "../terminal/types";
import { removeTask, startTask, taskStartOf } from "../workspace/tasks";
import { type CliUiHandler, UiRequestError } from "./handler";
import type { LayoutOp } from "./layout-actions";
import { findTabs, groupOf, openTab, showOpenTab } from "./placement";

export { type CliUiHandler, UiRequestError } from "./handler";

function hasAnyProfile(id: string): boolean {
  const config = useAgentProfilesStore.getState().config;
  return PROFILE_AGENTS.some((agent) => hasProfile(config, agent, id));
}

const ENTER_DELAY_MS = 120;

const TERMINAL_START_MS = 10_000;

export async function startedTerminal(
  workspaceId: string,
  tabId: string,
): Promise<TerminalController> {
  const until = Date.now() + TERMINAL_START_MS;
  let controller = getTerminalController(tabId);
  if (!controller) {
    if (tabRecord(workspaceId, tabId).type !== "terminal") {
      throw new UiRequestError("that tab is not a terminal");
    }
    useMountedWorkspacesStore.getState().mount(workspaceId);
    controller = await whenTerminalController(tabId, TERMINAL_START_MS);
  }
  if (!controller || !(await controller.whenReady(Math.max(0, until - Date.now())))) {
    throw new UiRequestError("that terminal did not start");
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
    | "tab.sandboxSession"
    | "terminal.read"
    | "terminal.watch"
    | "terminal.unwatch"
    | "events.read"
    | "sessions.results"
    | "sessions.snapshot"
    | "sessions.markSeen"
    | "settings.instructions"
    | "settings.instructions.set"
    | "settings.keys"
    | "settings.keys.set"
    | "settings.lspStatus"
    | "settings.updateStatus"
    | "settings.updateCheck"
    | "settings.logsPath"
    | "settings.list"
    | "settings.set"
    | "settings.open"
    | LayoutOp
    | `chat.${string}`
    | `note.${string}`
    | `agentView.${string}`
  >]: CliUiHandler<K>;
} = {
  "editor.open": async ({ workspaceId, filePath, line, column, view, placement }) => {
    const previewable = isPreviewable(filePath) === "supported";
    if (view === "preview" && !previewable) {
      throw new UiRequestError(`${filePath.split(/[\\/]/).pop()} has no preview`);
    }
    const open = findTabs(
      workspaceId,
      (tab) => tab.type === "editor" && tab.props.filePath === filePath,
    );
    const tabId =
      showOpenTab(workspaceId, open, placement) ??
      openTab(workspaceId, { type: "editor", props: { workspaceId, filePath } }, placement);
    if (view !== undefined && previewable) {
      useTabsStore
        .getState()
        .setViewMode(workspaceId, tabId, view === "source" ? "raw" : "preview");
    }
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

  "terminal.reopen": async ({ workspaceId, tabId }) => {
    const tab = tabRecord(workspaceId, tabId);
    if (tab.type !== "terminal" || !tab.props.dead)
      throw new UiRequestError("that terminal has not exited");
    const controller = await startedTerminal(workspaceId, tabId);
    await controller.reopen();
    useTabsStore.getState().setTerminalDead(workspaceId, tabId, false);
    return {};
  },

  "terminal.open": async ({
    workspaceId,
    cwd,
    title,
    command,
    shell,
    profile,
    openedBy,
    placement,
  }) => {
    const choice = shell === undefined ? undefined : (await shellByName(shell)).choice;
    if (profile !== undefined && !hasAnyProfile(profile)) {
      throw new UiRequestError(`no profile "${profile}"`);
    }
    const props = {
      cwd,
      ...(choice ? { shell: choice } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(openedBy ? { openedBy } : {}),
    };
    const tabId = openTab(workspaceId, { type: "terminal", props }, placement);
    if (title) useTabsStore.getState().renameTab(workspaceId, tabId, title);
    if (command) queueStartupInput(workspaceId, tabId, () => `${command}\r`);
    useMountedWorkspacesStore.getState().mount(workspaceId);
    return { tabId };
  },

  "terminal.shells": async () => {
    const { entries, defaultShell } = await loadShellMenu();
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

  "terminal.input": async ({ workspaceId, tabId, text, mode, enter }) => {
    const controller = await startedTerminal(workspaceId, tabId);
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
    if (isAgentViewShown() && holdsInAgentView(tabRecord(workspaceId, tabId).type)) {
      showBesideCaller(workspaceId, tabId, caller ?? null);
      return {};
    }
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
    await closeTabWithConfirm(workspaceId, tabId, { askIfRunning: false });
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
    const applied = await reloadModelFromDisk(input);
    return { filePath: input.filePath, reverted: applied && !hasUnsavedChanges(workspaceId, tab) };
  },

  "browser.permissions": async ({ workspaceId }) => ({
    global: useBrowserPermissionsStore.getState().grants,
    sites: unwrapIpcResult(
      await ipcCallResult("browserPermission", "listRemembered", { workspaceId }),
    ).map(({ origin, permission, decision }) => ({ origin, permission, decision })),
  }),
  "browser.devtools": async ({ workspaceId, tabId }) => {
    if (tabRecord(workspaceId, tabId).type !== "browser")
      throw new UiRequestError("choose a browser tab");
    await callOrFail(ipcCallResult("browser", "openDevTools", { tabId }));
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

  "workspace.folders": async ({ workspaceId }) => {
    const folders = new Set<string>();
    for (const tab of Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {})) {
      if (tab.type !== "claude") continue;
      for (const dir of existingChatController(workspaceId, tab.id)?.addedDirectories() ?? []) {
        folders.add(dir);
      }
    }
    return { folders: [...folders] };
  },

  "workspace.dismissNotifications": async ({ workspaceId }) => {
    await callOrFail(ipcCallResult("claude", "clearWorkspace", { workspaceId }));
    useClaudeStatusStore.getState().clearWorkspace(workspaceId);
    return {};
  },

  "editor.newUntitled": async ({ workspaceId }) => ({
    tabId: openNewUntitledTab(workspaceId).id,
  }),

  "editor.encoding": async ({ workspaceId, tabId, reopen, saveAs }) => {
    const tab = tabRecord(workspaceId, tabId);
    if (tab.type !== "editor" || tab.props.origin === "untitled")
      throw new UiRequestError("choose a file tab");
    const input = fileOfTab(workspaceId, tab);
    const before = getResolvedModel(input);
    if (!before) throw new UiRequestError("show the file in the editor to load its encoding");
    if (reopen !== undefined || saveAs !== undefined) {
      const encoding = TEXT_ENCODINGS.find((item) => item.id === (reopen ?? saveAs))?.id;
      if (!encoding)
        throw new UiRequestError("unknown encoding; run tab encoding without flags to list them");
      if (reopen !== undefined) {
        if (isDirty(before.cacheUri))
          throw new UiRequestError("save the file before reopening it in another encoding");
        if (!(await reloadModelFromDisk(input, encoding)))
          throw new UiRequestError("could not reopen the file");
      } else {
        const saved = await saveModel(input, { encoding });
        if (saved.kind !== "saved")
          throw new UiRequestError(
            saved.kind === "error" ? saved.message : `could not save the file (${saved.kind})`,
          );
      }
    }
    const current = getResolvedModel(input);
    if (!current) throw new UiRequestError("that editor was closed");
    return {
      encoding: current.encoding,
      dirty: isDirty(current.cacheUri),
      readOnly: current.readOnly,
      choices: TEXT_ENCODINGS.map(({ id, name }) => ({ id, name })),
    };
  },

  "workspace.show": async ({ workspaceId }) => {
    activateWorkspace(workspaceId);
    return {};
  },

  "task.create": async ({
    parentId,
    name,
    prompt,
    start,
    show,
    createdBy,
    from,
    allowTerminal,
    openedBy,
  }) => {
    const how = start ?? taskStartOf(resolvedTaskAgent());
    if (allowTerminal === false && "command" in how && how.command)
      throw new UiRequestError("a worktree command requires terminal control");
    const started = await startTask(parentId, name, prompt, how, createdBy, from, openedBy);
    if (!("task" in started)) throw new UiRequestError(started.message);
    if (started.tabId === null) {
      if (show) activateWorkspace(started.task.id);
      return { workspaceId: started.task.id, start: started.start };
    }
    const tab = useTabsStore.getState().byWorkspace[started.task.id]?.[started.tabId];
    if (show && createdBy && isAgentViewShown() && tab && holdsInAgentView(tab.type)) {
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

  "consent.ask": async (args) => {
    const { id, fromWorkspaceId, fromTabId, toWorkspaceId, change, timeoutMs, fromDevice } = args;
    const workspaces = useWorkspacesStore.getState().workspaces;
    const name = (id: string) => workspaces.find((w) => w.id === id)?.name ?? shortId(id);
    const fromTab = fromDevice
      ? undefined
      : useTabsStore.getState().byWorkspace[fromWorkspaceId]?.[fromTabId];
    const answer = await askCliConsent({
      ...(id ? { id } : {}),
      fromWorkspace: fromDevice ? "" : name(fromWorkspaceId),
      fromTab: args.fromName ?? fromTab?.title ?? shortId(fromTabId),
      ...(fromTab?.type === "claude" || fromTab?.type === "codex"
        ? { fromAgent: fromTab.type }
        : {}),
      ...(fromDevice ? { fromDevice } : {}),
      toWorkspace: name(toWorkspaceId),
      sameWorkspace: !fromDevice && fromWorkspaceId === toWorkspaceId,
      change,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { answer };
  },

  "consent.settle": async ({ id, answer, by }) => ({ settled: settleCliConsent(id, answer, by) }),
};

async function shellByName(name: string): Promise<ShellEntry> {
  const { entries } = await loadShellMenu();
  const entry = shellNamed(entries, name);
  if (entry) return entry;
  const names = entries.map((e) => e.name).join(", ");
  throw new UiRequestError(`no shell is named "${name}"; this machine has ${names}`);
}
