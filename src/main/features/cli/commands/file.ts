import { CliError } from "../context";
import { pull } from "../file-pull";
import { type CliCommand, output } from "../registry";
import { deviceFlag } from "../remote";
import { WORKSPACE_FLAG } from "./flags";

const filePull: CliCommand = {
  path: ["file", "pull"],
  args: "<remote-path> [local-path]",
  summary: "Copy a file from another NexusCode computer",
  details:
    "Give both --device and --workspace. Remote relative paths start at that workspace. Local relative paths start at this shell's cwd.",
  flags: {
    device: {
      type: "string",
      value: "DEVICE",
      description: "The remote computer (id, id prefix or name)",
    },
    workspace: { ...WORKSPACE_FLAG, description: "The remote workspace (id, id prefix or name)" },
    recursive: { type: "boolean", short: "r", description: "Copy a directory and its contents" },
  },
  async run(ctx, { positionals: [remotePath, localPath, ...extra], flags }) {
    const device = deviceFlag(flags);
    if (!device) throw new CliError("give --device to choose a remote computer", 2);
    if (!remotePath || extra.length > 0 || localPath === "") {
      throw new CliError("give <remote-path> [local-path]", 2);
    }
    const workspace = typeof flags.workspace === "string" ? flags.workspace : undefined;
    const recursive = flags.recursive === true;
    try {
      const result = await pull(ctx, {
        device,
        remotePath,
        recursive,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(localPath !== undefined ? { localPath } : {}),
      });
      const records = result.entries.map((entry) => ({ device: result.device, ...entry }));
      const lines = result.entries.map((entry) =>
        "skipped" in entry
          ? `Skipped symlink ${JSON.stringify(entry.remotePath)}`
          : `${JSON.stringify(entry.path)}  ${entry.size} bytes  sha256 ${entry.sha256}`,
      );
      return output(
        lines.join("\n") || `Copied directory to ${JSON.stringify(result.destination)}`,
        recursive ? records : records[0],
      );
    } catch (error) {
      if (ctx.signal?.aborted) throw new CliError("file pull cancelled", 3);
      if (!(error instanceof Error)) throw error;
      const message = error.message.replace(/[\r\n]+/g, " ");
      if (message === error.message) throw error;
      throw error instanceof CliError
        ? new CliError(message, error.exitCode, error.json)
        : new CliError(message);
    }
  },
};

export const fileCommands: CliCommand[] = [filePull];
