import { CliUsageError } from "../args";
import { CliError } from "../context";
import { pull } from "../file-pull";
import { push } from "../file-push";
import type { FileTransfer } from "../file-transfer";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import {
  agentSenderOf,
  askPeerCli,
  deviceFlag,
  deviceRef,
  peerWorkspace,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { WORKSPACE_FLAG } from "./flags";

const flagsOfFile = {
  device: {
    type: "string",
    value: "DEVICE",
    description: "The remote computer (id, id prefix or name)",
  },
  workspace: { ...WORKSPACE_FLAG, description: "The remote workspace (id, id prefix or name)" },
  recursive: { type: "boolean", short: "r", description: "Copy a directory and its contents" },
} as const;

const details =
  "Give both --device and --workspace. Remote relative paths start at that workspace. " +
  "Absolute paths outside it require terminal control. Local relative paths start at this shell's cwd.";

async function copy(
  verb: "pull" | "push",
  signal: AbortSignal | undefined,
  array: boolean,
  run: () => Promise<FileTransfer>,
) {
  try {
    const result = await run();
    const records = result.entries.map((entry) => ({ device: result.device, ...entry }));
    const lines = result.entries.map((entry) => {
      if ("skipped" in entry)
        return `Skipped symlink ${JSON.stringify(entry.remotePath ?? entry.path)}`;
      const destination = verb === "pull" ? entry.path : entry.remotePath;
      return `${JSON.stringify(destination)}  ${entry.size} bytes  sha256 ${entry.sha256}`;
    });
    return output(
      lines.join("\n") || `Copied directory to ${JSON.stringify(result.destination)}`,
      array ? records : records[0],
    );
  } catch (error) {
    if (signal?.aborted) throw new CliError(`file ${verb} cancelled`, 3);
    if (!(error instanceof Error)) throw error;
    const message = error.message.replace(/[\r\n]+/g, " ");
    if (message === error.message) throw error;
    throw error instanceof CliError
      ? new CliError(message, error.exitCode, error.json)
      : new CliError(message);
  }
}

const filePull: CliCommand = {
  path: ["file", "pull"],
  args: "<remote-path> [local-path]",
  summary: "Copy a file from another NexusCode computer",
  details,
  flags: flagsOfFile,
  async run(ctx, { positionals: [remotePath, localPath, ...extra], flags }) {
    const device = deviceFlag(flags);
    if (!device) throw new CliError("give --device to choose a remote computer", 2);
    if (!remotePath || extra.length > 0 || localPath === "") {
      throw new CliError("give <remote-path> [local-path]", 2);
    }
    const workspace = typeof flags.workspace === "string" ? flags.workspace : undefined;
    const recursive = flags.recursive === true;
    return copy("pull", ctx.signal, recursive, () =>
      pull(ctx, {
        device,
        remotePath,
        recursive,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(localPath !== undefined ? { localPath } : {}),
      }),
    );
  },
};

const filePush: CliCommand = {
  path: ["file", "push"],
  args: "<local-path...> <remote-path>",
  summary: "Copy files to another NexusCode computer",
  details,
  flags: flagsOfFile,
  async run(ctx, { positionals, flags }) {
    const device = deviceFlag(flags);
    if (!device) throw new CliError("give --device to choose a remote computer", 2);
    const localPaths = positionals.slice(0, -1);
    const remotePath = positionals.at(-1);
    if (!remotePath || localPaths.length === 0 || localPaths.includes("")) {
      throw new CliError("give <local-path...> <remote-path>", 2);
    }
    const workspace = typeof flags.workspace === "string" ? flags.workspace : undefined;
    const recursive = flags.recursive === true;
    return copy("push", ctx.signal, recursive || localPaths.length > 1, () =>
      push(ctx, {
        device,
        localPaths,
        remotePath,
        recursive,
        ...(workspace !== undefined ? { workspace } : {}),
      }),
    );
  },
};

const fileList: CliCommand = {
  path: ["file", "list"],
  args: "[path]",
  summary: "List a folder on another computer without downloading files",
  flags: { device: flagsOfFile.device, workspace: flagsOfFile.workspace },
  async run(ctx, { positionals: [folder = "", ...extra], flags }) {
    if (extra.length) throw new CliUsageError("give at most one folder");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (!device) throw new CliUsageError("give --device to choose a remote computer");
    requirePeerCli(ctx, device);
    const workspace = await peerWorkspace(ctx, device, flags.workspace);
    const result = await askPeerCli(ctx, device, "files.list", {
      workspaceId: workspace.id,
      path: folder,
      from: await agentSenderOf(ctx),
    });
    const rows = table(
      ["NAME", "KIND", "BYTES"],
      result.entries.map((entry) => [entry.name, entry.kind, String(entry.size ?? "")]),
    );
    return output(
      [result.path, rows, result.truncated ? "More entries omitted." : ""]
        .filter(Boolean)
        .join("\n"),
      { device: deviceRef(device), ...result },
    );
  },
};

export const fileCommands: CliCommand[] = [fileList, filePull, filePush];
