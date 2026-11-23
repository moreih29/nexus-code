import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mergeAgentEnv,
  profileDirectory,
  profileVariables,
} from "../../../shared/agent-profiles/env";
import {
  type AgentProfile,
  PROFILE_DIR_ENV,
  SHAREABLE,
} from "../../../shared/agent-profiles/profiles";
import {
  type AgentProfileStatus,
  claudeStatusOf,
  codexStatusOf,
} from "../../../shared/agent-profiles/status";
import { posixShellString, powerShellString } from "../../../shared/pty/shell";
import { findOnPath, nodeShellHost } from "../pty/shells";

const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const windows = process.platform === "win32";

const INHERITED_ONLY = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

export function expandHome(dir: string, home = os.homedir()): string {
  const trimmed = dir.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    return path.join(home, trimmed.slice(2));
  return trimmed;
}

export function localDefaultDir(agent: AgentProfile["agent"]): string {
  const set = process.env[PROFILE_DIR_ENV[agent]]?.trim();
  if (set) return path.resolve(expandHome(set));
  return path.join(os.homedir(), agent === "claude" ? ".claude" : ".codex");
}

export function localProfileDir(profile: AgentProfile): string {
  const dir = profileDirectory(profile, windows);
  return dir ? path.resolve(expandHome(dir)) : localDefaultDir(profile.agent);
}

export function localProfileEnv(
  profile: AgentProfile,
  base: NodeJS.ProcessEnv = process.env,
  onWindows = windows,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => !INHERITED_ONLY.includes(onWindows ? key.toUpperCase() : key),
    ),
  );
  const dir = profileDirectory(profile, onWindows);
  const variables = profileVariables(profile.env, onWindows);
  return mergeAgentEnv(
    onWindows,
    inherited,
    variables,
    dir ? { [PROFILE_DIR_ENV[profile.agent]]: path.resolve(expandHome(dir)) } : {},
  );
}

export async function prepareLocalProfile(
  profile: AgentProfile,
): Promise<{ dir: string; linked: string[]; failed: string[] }> {
  const dir = localProfileDir(profile);
  if (profile.dir.trim() === "") return { dir, linked: [], failed: [] };
  const defaultDir = localDefaultDir(profile.agent);
  if (samePath(dir, defaultDir)) throw new Error(`${dir} is the default folder`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const shared = new Set(profile.shared ?? []);
  const linked: string[] = [];
  const failed: string[] = [];
  const names = new Set([...SHAREABLE[profile.agent], ...shared]);
  for (const name of names) {
    if (name === "" || name.includes("/") || name.includes("\\") || name === "..") continue;
    const target = path.join(defaultDir, name);
    const link = path.join(dir, name);
    const current = await fs.lstat(link).catch(() => null);
    const pointsHome = current ? await linksTo(link, current, target) : false;
    if (!shared.has(name)) {
      if (pointsHome) await fs.rm(link, { force: true }).catch(() => {});
      continue;
    }
    if (current) {
      if (pointsHome) linked.push(name);
      continue;
    }
    const source = await fs.stat(target).catch(() => null);
    if (!source) continue;
    try {
      await makeLink(target, link, source.isDirectory());
      linked.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { dir, linked, failed };
}

async function makeLink(target: string, link: string, dir: boolean): Promise<void> {
  if (!windows) return fs.symlink(target, link);
  if (dir) return fs.symlink(target, link, "junction");
  await fs.symlink(target, link, "file").catch(() => fs.link(target, link));
}

async function linksTo(link: string, current: Stats, target: string): Promise<boolean> {
  if (current.isSymbolicLink()) {
    const got = await fs.readlink(link).catch(() => "");
    return got !== "" && samePath(path.resolve(path.dirname(link), got), target);
  }
  if (!windows || !current.isFile()) return false;
  const [own, shared] = await Promise.all([
    fs.stat(link, { bigint: true }),
    fs.stat(target, { bigint: true }).catch(() => null),
  ]);
  return shared !== null && own.ino === shared.ino && own.dev === shared.dev;
}

export async function inspectLocalFolder(
  agent: AgentProfile["agent"],
  dir: string,
): Promise<{ exists: boolean; linked: string[] }> {
  const folder = path.resolve(expandHome(dir));
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) return { exists: false, linked: [] };
  const defaultDir = localDefaultDir(agent);
  const linked: string[] = [];
  for (const name of SHAREABLE[agent]) {
    const link = path.join(folder, name);
    const current = await fs.lstat(link).catch(() => null);
    if (current && (await linksTo(link, current, path.join(defaultDir, name)))) linked.push(name);
  }
  return { exists: true, linked };
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return windows || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function notOnPath(program: string, env: NodeJS.ProcessEnv): boolean {
  return windows && findOnPath({ ...nodeShellHost(), env }, program) === null;
}

function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  if (notOnPath(program, env)) return Promise.resolve({ code: null, stdout: "", missing: true });
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { env, timeout: STATUS_TIMEOUT_MS, windowsHide: true, shell: windows, maxBuffer: 1 << 20 },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
        resolve({ code, stdout: String(stdout), missing });
      },
    );
  });
}

function stop(child: ChildProcess): void {
  if (windows && child.pid !== undefined && child.exitCode === null) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  child.kill();
}

export async function localProfileStatus(profile: AgentProfile): Promise<AgentProfileStatus> {
  const env = localProfileEnv(profile);
  if (profile.agent === "claude") {
    const result = await run("claude", ["auth", "status", "--json"], env);
    if (result.missing)
      return {
        state: "unavailable",
        message: "claude was not found on the PATH",
        reason: "missing",
      };
    return (
      claudeStatusOf(result.stdout) ?? {
        state: "unavailable",
        message: "claude auth status gave no answer",
        reason: "no-answer",
      }
    );
  }
  const authJson = await fs
    .readFile(path.join(localProfileDir(profile), "auth.json"), "utf8")
    .catch(() => null);
  const fromFile = authJson !== null ? codexStatusOf(authJson) : null;
  if (fromFile) return fromFile;
  if (profile.dir.trim() !== "") await fs.mkdir(localProfileDir(profile), { recursive: true });
  const result = await run("codex", ["login", "status"], env);
  if (result.missing)
    return { state: "unavailable", message: "codex was not found on the PATH", reason: "missing" };
  return result.code === 0 ? { state: "signed-in" } : { state: "signed-out" };
}

export function loginCommand(profile: AgentProfile, onWindows = windows): string {
  const program = profile.agent === "claude" ? "claude auth login" : "codex login";
  if (profile.dir.trim() === "") return program;
  const key = PROFILE_DIR_ENV[profile.agent];
  const dir = localProfileDir(profile);
  if (onWindows) return `$env:${key}=${powerShellString(dir)}; ${program}`;
  return `${key}=${posixShellString(dir)} ${program}`;
}

export interface LoginEvents {
  output(id: string, text: string): void;
  exit(id: string, code: number | null): void;
}

export class LocalLogins {
  private readonly running = new Map<string, ChildProcess>();

  constructor(private readonly events: LoginEvents) {}

  async start(profile: AgentProfile): Promise<{ id: string; command: string }> {
    await prepareLocalProfile(profile);
    const env = localProfileEnv(profile);
    if (notOnPath(profile.agent, env))
      throw new Error(`${profile.agent} was not found on the PATH`);
    const id = randomUUID();
    const args = profile.agent === "claude" ? ["auth", "login"] : ["login"];
    const child = spawn(profile.agent, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: windows,
    });
    this.running.set(id, child);
    const timer = setTimeout(() => stop(child), LOGIN_TIMEOUT_MS);
    const forward = (chunk: Buffer) => this.events.output(id, chunk.toString("utf8"));
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.running.delete(id);
      this.events.exit(id, code);
    };
    child.on("error", (err) => {
      this.events.output(id, `${err.message}\n`);
      end(null);
    });
    child.on("close", (code) => end(code));
    return { id, command: loginCommand(profile) };
  }

  input(id: string, text: string): void {
    this.running.get(id)?.stdin?.write(`${text}\n`);
  }

  cancel(id: string): void {
    const child = this.running.get(id);
    if (child) stop(child);
  }

  dispose(): void {
    for (const child of this.running.values()) stop(child);
    this.running.clear();
  }
}
