/**
 * nexus manager show/hide/new: the agent manager's dock, and its
 * conversation started over. The manager is the app's, not a workspace's,
 * so these need no leave.
 */
import { isManager } from "../../../../shared/manager/manager";
import { exactArgs } from "../args";
import { CliError } from "../context";
import { type CliCommand, output } from "../registry";

function dockCommand(open: boolean): CliCommand {
  return {
    path: ["manager", open ? "show" : "hide"],
    summary: open ? "Open the agent manager's dock" : "Close the agent manager's dock",
    details: open
      ? "The dock beside the workspace, in either view, with the manager's conversation and\n" +
        "the tasks it handed out. While the manager is off, the dock offers to turn it on."
      : "The manager goes on running; its answers count as unread until the dock opens.",
    async run(ctx, { positionals }) {
      exactArgs(positionals);
      const { enabled } = await ctx.services.ui("manager.dock", { open });
      const off = enabled ? "" : " The agent manager is off (Settings › Agent manager).";
      return output(`${open ? "Opened" : "Closed"} the agent manager's dock.${off}`, {
        open,
        enabled,
      });
    },
  };
}

const managerNew: CliCommand = {
  path: ["manager", "new"],
  summary: "Start the agent manager over, in a new conversation",
  details:
    "As its dock's New conversation does: the manager stops what it is doing and starts a new\n" +
    "conversation; the old one stays in its history, to resume.",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    if (isManager(ctx.caller)) {
      throw new CliError("that is this conversation; the user starts it over, in the dock");
    }
    await ctx.services.ui("manager.new", {});
    return output("Started the agent manager over, in a new conversation.", {});
  },
};

export const managerCommands: CliCommand[] = [dockCommand(true), dockCommand(false), managerNew];
