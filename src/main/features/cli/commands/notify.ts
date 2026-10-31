/** nexus notify. */
import { CliUsageError } from "../args";
import { type CliCommand, output } from "../registry";

const notify: CliCommand = {
  path: ["notify"],
  summary: "Tell the user something, as a desktop notification",
  args: "<message>",
  details:
    "Shown unless the user is looking at this terminal; clicking it brings them here.\n" +
    "Follows the notification setting in Settings.",
  flags: {
    title: { type: "string", value: "TITLE", description: "The notification's title" },
  },
  async run(ctx, { positionals, flags }) {
    const body = positionals.join(" ").trim();
    if (body === "") throw new CliUsageError("give the message to show");
    const title = (flags.title as string | undefined) ?? "";
    const shown = ctx.services.notify(ctx.caller.workspaceId, ctx.caller.tabId, title, body);
    return output(
      shown
        ? "Notified."
        : "Not shown: the user is looking at this terminal or turned notifications off.",
      {
        shown,
      },
    );
  },
};

export const notifyCommands: CliCommand[] = [notify];
