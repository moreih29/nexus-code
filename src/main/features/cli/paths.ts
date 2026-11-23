import { realpathSync } from "node:fs";
import path from "node:path";
import type { CliInvocation } from "../../../shared/cli/protocol";
import { toSlashPath } from "../../../shared/fs/drive-path";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { type CliContext, CliError } from "./context";

export function onAppMachine(ctx: CliContext): boolean {
  const own = ctx.services.listWorkspaces().find((w) => w.id === ctx.caller.workspaceId);
  return own?.location.kind === "local";
}

function rulesOf(absolute: string): path.PlatformPath {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(absolute) ? path.win32 : path.posix;
}

function hostPath(workspace: WorkspaceMeta): path.PlatformPath {
  return rulesOf(workspace.rootPath);
}

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

export function callerPath(
  ctx: CliContext,
  input: string,
  base: string = ctx.invocation.cwd,
): string {
  const rules = rulesOf(base);
  return rules.resolve(base, rules === path.win32 ? fromGitBash(input, ctx.invocation) : input);
}

export function absolutePath(ctx: CliContext, workspace: WorkspaceMeta, input: string): string {
  const base = workspace.id === ctx.caller.workspaceId ? ctx.invocation.cwd : workspace.rootPath;
  const rules = hostPath(workspace);
  return rules.resolve(base, rules === path.win32 ? fromGitBash(input, ctx.invocation) : input);
}

export interface WorkspaceFile {
  readonly relPath: string;
  readonly filePath: string;
}

export function workspaceFile(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  input: string,
): WorkspaceFile {
  const p = hostPath(workspace);
  const absolute = absolutePath(ctx, workspace, input);
  const outside = (rel: string) =>
    rel === "" || rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel);
  let rel = p.relative(workspace.rootPath, absolute);
  if (outside(rel) && workspace.location.kind === "local" && p === path) {
    rel = p.relative(followed(workspace.rootPath), followed(absolute));
  }
  if (outside(rel)) {
    throw new CliError(`${input} is not a file inside ${workspace.name} (${workspace.rootPath})`);
  }
  const relPath = rel.split(p.sep).join("/");
  return { relPath, filePath: `${rendererRoot(workspace)}/${relPath}` };
}

function followed(file: string): string {
  const parent = path.dirname(file);
  try {
    return realpathSync.native(file);
  } catch {
    return parent === file ? file : path.join(followed(parent), path.basename(file));
  }
}

export function rendererRoot(workspace: WorkspaceMeta): string {
  return toSlashPath(workspace.rootPath.replace(/[\\/]+$/, ""));
}

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
