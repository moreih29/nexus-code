// Agent profiles on this machine, for Settings: their folders made, who
// each is signed in as, and their sign-ins run. A chat tab's profile is set
// up on its workspace's host by the agent instead (chat.profileDir).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { findOnPath, nodeShellHost } from "../pty/shells";

const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const windows = process.platform === "win32";

/** Variables a parent Claude Code session sets, which a program of its own must not inherit. */
const INHERITED_ONLY = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/** "~" and "~/…" against this machine's home. */
export function expandHome(dir: string, home = os.homedir()): string {
  const trimmed = dir.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    return path.join(home, trimmed.slice(2));
  return trimmed;
}

/** The folder the agent uses here with no profile. */
export function localDefaultDir(agent: AgentProfile["agent"]): string {
  const set = process.env[PROFILE_DIR_ENV[agent]]?.trim();
  if (set) return path.resolve(expandHome(set));
  return path.join(os.homedir(), agent === "claude" ? ".claude" : ".codex");
}

/** The profile's folder here, absolute; the default folder for the default profile. */
export function localProfileDir(profile: AgentProfile): string {
  return profile.dir.trim() === ""
    ? localDefaultDir(profile.agent)
    : path.resolve(expandHome(profile.dir));
}

/** The environment the agent's program runs with here, for the profile. */
export function localProfileEnv(
  profile: AgentProfile,
  base: NodeJS.ProcessEnv = process.env,
  onWindows = windows,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of INHERITED_ONLY) delete env[key];
  for (const [key, value] of Object.entries(profile.env ?? {})) setVar(env, key, value, onWindows);
  if (profile.dir.trim() !== "")
    setVar(env, PROFILE_DIR_ENV[profile.agent], localProfileDir(profile), onWindows);
  return env;
}

/**
 * Sets a variable. A Windows variable is one whatever the case of its name,
 * so there it takes the place of one named in another case ("Path" of
 * "PATH"): left beside it, the program would get either.
 */
function setVar(env: NodeJS.ProcessEnv, key: string, value: string, onWindows: boolean): void {
  if (onWindows) {
    const lower = key.toLowerCase();
    for (const other of Object.keys(env)) {
      if (other !== key && other.toLowerCase() === lower) delete env[other];
    }
  }
  env[key] = value;
}

/**
 * Makes the profile's folder, and links what it shares from the default
 * folder (a file the folder has of its own stays); a link no longer shared
 * goes. Nothing to do for the default profile.
 */
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

/**
 * Links `link` to `target`. Windows lets only an administrator, or a PC in
 * Developer Mode, make a symbolic link: there a folder gets a junction, which
 * needs no rights, and a file a hard link when its symbolic link fails.
 */
async function makeLink(target: string, link: string, dir: boolean): Promise<void> {
  if (!windows) return fs.symlink(target, link);
  if (dir) return fs.symlink(target, link, "junction");
  await fs.symlink(target, link, "file").catch(() => fs.link(target, link));
}

/**
 * Whether the entry at `link` leads to `target`: a symbolic link or junction
 * to it, dangling or not, or on Windows a hard link of the same file.
 */
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

/**
 * Whether a folder chosen for a new profile is there already, and which of
 * what it may share it links to the default folder now: a folder set up by
 * hand keeps its links unless the user unticks them.
 */
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

/**
 * Whether the program is not on the profile's PATH. On Windows it runs
 * through the shell (an npm install leaves a .cmd), whose "not recognized"
 * comes in the system's language and code page: the PATH is looked at instead.
 */
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

/**
 * Ends a sign-in's program. On Windows the shell runs it, and ending the
 * shell would leave `claude` or `codex` (and the port it waits on) behind:
 * the whole tree ends there.
 */
function stop(child: ChildProcess): void {
  if (windows && child.pid !== undefined && child.exitCode === null) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  child.kill();
}

/** Who the profile is signed in as here. */
export async function localProfileStatus(profile: AgentProfile): Promise<AgentProfileStatus> {
  const env = localProfileEnv(profile);
  if (profile.agent === "claude") {
    const result = await run("claude", ["auth", "status", "--json"], env);
    if (result.missing)
      return { state: "unavailable", message: "claude was not found on the PATH" };
    return (
      claudeStatusOf(result.stdout) ?? {
        state: "unavailable",
        message: "claude auth status gave no answer",
      }
    );
  }
  const authJson = await fs
    .readFile(path.join(localProfileDir(profile), "auth.json"), "utf8")
    .catch(() => null);
  const fromFile = authJson !== null ? codexStatusOf(authJson) : null;
  if (fromFile) return fromFile;
  // A sign-in kept in the keychain leaves no auth.json.
  if (profile.dir.trim() !== "") await fs.mkdir(localProfileDir(profile), { recursive: true });
  const result = await run("codex", ["login", "status"], env);
  if (result.missing) return { state: "unavailable", message: "codex was not found on the PATH" };
  return result.code === 0 ? { state: "signed-in" } : { state: "signed-out" };
}

/**
 * The command that signs a profile in, as the user would type it: in
 * PowerShell on Windows, with the folder in full since it reads no "~".
 */
export function loginCommand(profile: AgentProfile, onWindows = windows): string {
  const program = profile.agent === "claude" ? "claude auth login" : "codex login";
  if (profile.dir.trim() === "") return program;
  const key = PROFILE_DIR_ENV[profile.agent];
  if (onWindows) return `$env:${key}="${localProfileDir(profile)}"; ${program}`;
  return `${key}=${profile.dir} ${program}`;
}

export interface LoginEvents {
  output(id: string, text: string): void;
  exit(id: string, code: number | null): void;
}

/** The sign-ins running, by id: each a `claude auth login` or `codex login`. */
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
