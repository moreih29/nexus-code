/**
 * nexus agent-context: the note a Claude Code session started in the app
 * gets about nexus, printed by the SessionStart hook the claude wrapper adds
 * (scripts/assets/claude-wrapper.sh). Prints nothing when the setting is off.
 */
import { isManager } from "../../../../shared/manager/manager";
import { resolveWorkspace, shortId } from "../context";
import { type CliCommand, output } from "../registry";

const agentContext: CliCommand = {
  path: ["agent-context"],
  summary: "Print the note on nexus a Claude Code session gets at its start",
  hidden: true,
  async run(ctx) {
    if (!ctx.services.agentContextEnabled()) return output("", { note: null });
    // The manager is told what it is in its system prompt (shared/manager/prompt).
    if (isManager(ctx.caller)) return output("", { note: null });
    const workspace = resolveWorkspace(ctx, undefined);
    const note = [
      `You are running in a terminal of NexusCode (workspace "${workspace.name}", terminal ${shortId(ctx.caller.tabId)}).`,
      "The `nexus` command drives the app from here: see other workspaces' terminals and agent",
      "sessions (nexus session list, nexus terminal read), open files and diffs for the user",
      "(nexus open, nexus diff), run commands in new terminals (nexus terminal new --command),",
      "type into another agent's session and wait for it (nexus terminal send --wait), and notify",
      "the user (nexus notify). The app's Claude and Codex tabs are agents too: nexus chat new",
      "--prompt TEXT (--agent codex) opens one, and chat read, send --wait and wait follow it.",
      "nexus events --since N --wait 10m follows every session's state changes as they come.",
      "Work can be handed to another agent on its own branch and worktree: nexus worktree new",
      "NAME --prompt TEXT (--agent claude or codex; the task agent set in the app by default),",
      "then the chat wait it prints. Make worktrees with nexus worktree new, not git worktree add",
      "or a worktree tool of your own, so the user sees them as tasks in the app.",
      "The app's browser tabs can be opened and driven to check a web",
      "app: nexus browser open URL (or a bare /path, on the port this workspace's dev server",
      "listens on, as nexus port list shows), then snapshot (the page with element refs), click e12,",
      "fill e3 TEXT, press Enter, screenshot, console and eval. The workbench can be arranged",
      "too: nexus layout show/split/resize, tab move/rename/pin, panel show/hide, reveal,",
      "and nexus view agents|workspaces, view layout/open/split for the agent view's panels;",
      "nexus problems lists the language servers' errors in open files.",
      "When the user means an element on a page, nexus browser pick has them click it and",
      "prints its ref and selector.",
      "A claude -p or codex exec run you start, best in the background, is followed as a",
      "subagent is: nexus agent list, show, wait and stop; claude -p --resume ID (codex exec",
      "resume ID) goes on with it (not claude -p -c: that goes on your own session).",
      "Run `nexus help` for every command.",
    ].join("\n");
    return output(note, { note });
  },
};

export const agentContextCommands: CliCommand[] = [agentContext];
