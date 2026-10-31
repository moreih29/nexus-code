/**
 * Paths on the command line, read as the workspace's host spells them:
 * Windows paths for a workspace whose root is a Windows path, POSIX paths
 * otherwise.
 */
import path from "node:path";
import type { CliInvocation } from "../../../shared/cli/protocol";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { type CliContext, CliError } from "./context";

/** The path rules of the host `absolute` is a path on. */
function rulesOf(absolute: string): path.PlatformPath {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(absolute) ? path.win32 : path.posix;
}

function hostPath(workspace: WorkspaceMeta): path.PlatformPath {
  return rulesOf(workspace.rootPath);
}

/**
 * A path Git Bash spells, as Windows does: "/c/src" is C:\src, "/tmp" the
 * temp directory, and the rest is under Git's own folder. Any other caller's
 * path is as it was typed.
 */
export function fromGitBash(input: string, invocation: CliInvocation): string {
  const msysRoot = invocation.msysRoot;
  if (msysRoot === undefined || !input.startsWith("/")) return input;
  if (input.startsWith("//")) return input.replaceAll("/", "\\");
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(input);
  if (drive) return path.win32.join(`${drive[1]?.toUpperCase()}:\\`, drive[2] ?? "");
  const temp = /^\/tmp(?:\/(.*))?$/.exec(input);
  if (temp) return path.win32.join(invocation.tempDir, temp[1] ?? "");
  return msysRoot === "" ? input : path.win32.join(msysRoot, input);
}

/** Where `input` points on the caller's own host: from its directory, or from `base`. */
export function callerPath(
  ctx: CliContext,
  input: string,
  base: string = ctx.invocation.cwd,
): string {
  const rules = rulesOf(base);
  return rules.resolve(base, rules === path.win32 ? fromGitBash(input, ctx.invocation) : input);
}

/**
 * Where `input` points, made absolute: from the caller's directory in its own
 * workspace, from the root in another.
 */
export function absolutePath(ctx: CliContext, workspace: WorkspaceMeta, input: string): string {
  const base = workspace.id === ctx.caller.workspaceId ? ctx.invocation.cwd : workspace.rootPath;
  const rules = hostPath(workspace);
  return rules.resolve(base, rules === path.win32 ? fromGitBash(input, ctx.invocation) : input);
}

/** A file of a workspace: its path from the root, with "/", and as the editor names it. */
export interface WorkspaceFile {
  readonly relPath: string;
  readonly filePath: string;
}

/** The file `input` names, which must be inside the workspace. */
export function workspaceFile(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  input: string,
): WorkspaceFile {
  const p = hostPath(workspace);
  const rel = p.relative(workspace.rootPath, absolutePath(ctx, workspace, input));
  if (rel === "" || rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) {
    throw new CliError(`${input} is not a file inside ${workspace.name} (${workspace.rootPath})`);
  }
  const relPath = rel.split(p.sep).join("/");
  // The renderer joins a workspace's files to its root with "/" (files/helpers joinPath).
  const root = workspace.rootPath.replace(/[\\/]+$/, "");
  return { relPath, filePath: `${root}/${relPath}` };
}

/** Splits "file:12" or "file:12:5" into the file and the place in it. */
export function splitLocation(input: string): { file: string; line?: number; column?: number } {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(input);
  if (!match) return { file: input };
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (line < 1 || (column !== undefined && column < 1)) {
    throw new CliError(`lines and columns count from 1: ${input}`, 2);
  }
  return {
    file: match[1] as string,
    line,
    ...(column === undefined ? {} : { column }),
  };
}
