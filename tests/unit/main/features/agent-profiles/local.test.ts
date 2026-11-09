import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectLocalFolder,
  loginCommand,
  prepareLocalProfile,
} from "../../../../../src/main/features/agent-profiles/local";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";

const posix = process.platform !== "win32";

describe.if(posix)("a profile folder set up by hand", () => {
  let root: string;
  let defaultDir: string;
  let folder: string;
  let saved: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-profiles-"));
    defaultDir = path.join(root, "default");
    folder = path.join(root, "personal");
    await fs.mkdir(path.join(defaultDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(defaultDir, "settings.json"), "{}");
    await fs.mkdir(folder);
    // Linked by hand: one to a file the default folder has, one to a folder
    // it does not have (yet), and a file of the profile's own.
    await fs.symlink(path.join(defaultDir, "settings.json"), path.join(folder, "settings.json"));
    await fs.symlink(path.join(defaultDir, "plugins"), path.join(folder, "plugins"));
    await fs.writeFile(path.join(folder, "CLAUDE.md"), "mine");
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = defaultDir;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("shows what it links to the default folder now, a dangling link too", async () => {
    expect(await inspectLocalFolder("claude", folder)).toEqual({
      exists: true,
      linked: ["settings.json", "plugins"],
    });
    expect(await inspectLocalFolder("claude", path.join(root, "none"))).toEqual({
      exists: false,
      linked: [],
    });
  });

  test("keeps those links when they stay shared, and its own files always", async () => {
    const { linked } = await inspectLocalFolder("claude", folder);
    const profile: AgentProfile = {
      id: "claude-personal",
      agent: "claude",
      name: "Personal",
      color: "violet",
      dir: folder,
      shared: [...linked, "skills"],
    };
    const result = await prepareLocalProfile(profile);
    expect(result.linked.sort()).toEqual(["plugins", "settings.json", "skills"]);
    expect(await fs.readlink(path.join(folder, "plugins"))).toBe(path.join(defaultDir, "plugins"));
    expect(await fs.readFile(path.join(folder, "CLAUDE.md"), "utf8")).toBe("mine");
  });
});

// Without Developer Mode or an administrator, Windows makes no symbolic link:
// a shared folder is a junction there and a shared file a hard link.
describe.if(!posix)("a profile folder on Windows", () => {
  let root: string;
  let defaultDir: string;
  let folder: string;
  let saved: string | undefined;
  const profile = (shared: string[]): AgentProfile => ({
    id: "codex-personal",
    agent: "codex",
    name: "Personal",
    color: "violet",
    dir: folder,
    shared,
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-profiles-"));
    defaultDir = path.join(root, "default");
    folder = path.join(root, "personal");
    await fs.mkdir(path.join(defaultDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(defaultDir, "config.toml"), 'model = "x"\n');
    saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = defaultDir;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("links what it shares, folders and files, and knows them again", async () => {
    const result = await prepareLocalProfile(profile(["config.toml", "skills"]));
    expect(result.failed).toEqual([]);
    expect(result.linked.sort()).toEqual(["config.toml", "skills"]);
    expect(await fs.readFile(path.join(folder, "config.toml"), "utf8")).toBe('model = "x"\n');
    // Written through the link, the default folder's file changes too.
    await fs.appendFile(path.join(folder, "config.toml"), "effort = 1\n");
    expect(await fs.readFile(path.join(defaultDir, "config.toml"), "utf8")).toContain("effort");
    expect(await inspectLocalFolder("codex", folder)).toEqual({
      exists: true,
      linked: ["config.toml", "skills"],
    });
    expect((await prepareLocalProfile(profile(["config.toml", "skills"]))).linked.sort()).toEqual([
      "config.toml",
      "skills",
    ]);
  });

  test("unlinks what it no longer shares, leaving the default folder's", async () => {
    await prepareLocalProfile(profile(["config.toml", "skills"]));
    await prepareLocalProfile(profile([]));
    expect(await fs.readdir(folder)).toEqual([]);
    expect((await fs.readdir(defaultDir)).sort()).toEqual(["config.toml", "skills"]);
  });

  test("keeps a file of the profile's own", async () => {
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "config.toml"), "mine");
    const result = await prepareLocalProfile(profile(["config.toml"]));
    expect(result.linked).toEqual([]);
    expect(await fs.readFile(path.join(folder, "config.toml"), "utf8")).toBe("mine");
    expect((await inspectLocalFolder("codex", folder)).linked).toEqual([]);
  });
});

describe("the sign-in command shown", () => {
  const profile: AgentProfile = {
    id: "claude-work",
    agent: "claude",
    name: "Work",
    color: "violet",
    dir: "~/.claude-work",
  };

  test("sets the folder's variable as the user's shell takes it", () => {
    expect(loginCommand(profile, false)).toBe("CLAUDE_CONFIG_DIR=~/.claude-work claude auth login");
    expect(loginCommand(profile, true)).toBe(
      `$env:CLAUDE_CONFIG_DIR="${path.join(os.homedir(), ".claude-work")}"; claude auth login`,
    );
    expect(loginCommand({ ...profile, dir: "" }, true)).toBe("claude auth login");
  });
});
