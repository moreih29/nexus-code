// Agent profiles on this machine, for Settings: their folders made, who
// each is signed in as, and their sign-ins run. A chat tab's profile is set
// up on its workspace's host by the agent instead (chat.profileDir).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
export function localProfileEnv(profile: AgentProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_ONLY) delete env[key];
  Object.assign(env, profile.env ?? {});
  if (profile.dir.trim() !== "") env[PROFILE_DIR_ENV[profile.agent]] = localProfileDir(profile);
  return env;
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
    const pointsHome = current?.isSymbolicLink()
      ? samePath(await fs.readlink(link).catch(() => ""), target)
      : false;
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
      // A junction needs no rights on Windows, where a symlink may.
      await fs.symlink(target, link, windows && source.isDirectory() ? "junction" : undefined);
      linked.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { dir, linked, failed };
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
    if (!current?.isSymbolicLink()) continue;
    const target = await fs.readlink(link).catch(() => "");
    if (samePath(path.resolve(folder, target), path.join(defaultDir, name))) linked.push(name);
  }
  return { exists: true, linked };
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return windows || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { env, timeout: STATUS_TIMEOUT_MS, windowsHide: true, shell: windows, maxBuffer: 1 << 20 },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        const missing =
          (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ||
          (windows && code === 1 && /not recognized/i.test(String(error?.message)));
        resolve({ code, stdout: String(stdout), missing });
      },
    );
  });
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

/** The command that signs a profile in, as the user would type it. */
export function loginCommand(profile: AgentProfile): string {
  const program = profile.agent === "claude" ? "claude auth login" : "codex login";
  if (profile.dir.trim() === "") return program;
  return `${PROFILE_DIR_ENV[profile.agent]}=${profile.dir} ${program}`;
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
    const id = randomUUID();
    const args = profile.agent === "claude" ? ["auth", "login"] : ["login"];
    const child = spawn(profile.agent, args, {
      env: localProfileEnv(profile),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: windows,
    });
    this.running.set(id, child);
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
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
    this.running.get(id)?.kill();
  }

  dispose(): void {
    for (const child of this.running.values()) child.kill();
    this.running.clear();
  }
}
