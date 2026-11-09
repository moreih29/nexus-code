import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectLocalFolder,
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
