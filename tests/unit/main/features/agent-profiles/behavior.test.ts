import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readBehavior,
  unshareBehaviorFile,
  writeBehavior,
} from "../../../../../src/main/features/agent-profiles/behavior";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";

const posix = process.platform !== "win32";

let root: string;
let defaultDir: string;
let ownDir: string;
let saved: Record<string, string | undefined>;

const claudeProfile = (dir: string, shared: string[] = []): AgentProfile => ({
  id: dir === "" ? "claude-default" : "claude-x",
  agent: "claude",
  name: "x",
  color: "blue",
  dir,
  shared,
});
const codexProfile = (dir: string, shared: string[] = []): AgentProfile => ({
  id: dir === "" ? "codex-default" : "codex-x",
  agent: "codex",
  name: "x",
  color: "cyan",
  dir,
  shared,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-behavior-"));
  defaultDir = path.join(root, "default");
  ownDir = path.join(root, "own");
  await fs.mkdir(defaultDir);
  await fs.mkdir(ownDir);
  saved = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = defaultDir;
  process.env.CODEX_HOME = defaultDir;
});

afterEach(async () => {
  if (saved.c === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.c;
  if (saved.x === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.x;
  await fs.rm(root, { recursive: true, force: true });
});

const read = (file: string) => fs.readFile(file, "utf8");

describe("settings.json", () => {
  test("reads the fields it knows and flags none for a missing file", async () => {
    const profile = claudeProfile("");
    const missing = await readBehavior(profile);
    expect(missing).toMatchObject({ exists: false, broken: null, version: "missing", values: {} });
    await fs.writeFile(
      path.join(defaultDir, "settings.json"),
      JSON.stringify({
        model: "opus",
        permissions: { defaultMode: "plan", allow: ["Bash(ls)"] },
        sandbox: { enabled: true },
        attribution: { commit: "", pr: "" },
        language: 3,
      }),
    );
    const got = await readBehavior(profile);
    expect(got.values).toEqual({
      model: "opus",
      permissionMode: "plan",
      sandbox: true,
      attribution: false,
    });
    expect(got.unsupported).toEqual(["language"]);
  });

  test("lists the user's own output styles by their name or file name", async () => {
    const styles = path.join(defaultDir, "output-styles");
    await fs.mkdir(styles);
    await fs.writeFile(path.join(styles, "terse.md"), "---\nname: Very Terse\n---\nBe brief");
    await fs.writeFile(path.join(styles, "plain.md"), "No front matter");
    await fs.writeFile(path.join(styles, "notes.txt"), "not a style");
    expect((await readBehavior(claudeProfile(""))).outputStyles).toEqual(["plain", "Very Terse"]);
    expect((await readBehavior(codexProfile(""))).outputStyles).toEqual([]);
  });

  test("changes only what was asked and keeps unknown keys, their order and the indent", async () => {
    const file = path.join(defaultDir, "settings.json");
    const before = {
      hooks: { PreToolUse: [] },
      permissions: { allow: ["Bash(ls)"], defaultMode: "plan" },
      theme: "dark",
      model: "opus",
    };
    await fs.writeFile(file, `${JSON.stringify(before, null, "\t")}\n`);
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    const result = await writeBehavior(profile, version, { language: "Korean", thinking: false });
    expect(result.status).toBe("saved");
    expect(await read(file)).toBe(
      `${JSON.stringify({ ...before, language: "Korean", alwaysThinkingEnabled: false }, null, "\t")}\n`,
    );
  });

  test("a default value removes the key, and a table it empties", async () => {
    const file = path.join(defaultDir, "settings.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        model: "opus",
        alwaysThinkingEnabled: false,
        sandbox: { enabled: true },
        permissions: { defaultMode: "plan" },
        outputStyle: "Concise",
        attribution: { commit: "", pr: "" },
        includeCoAuthoredBy: false,
        keep: 1,
      }),
    );
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    const result = await writeBehavior(profile, version, {
      model: null,
      thinking: true,
      sandbox: false,
      permissionMode: "default",
      outputStyle: "default",
      attribution: true,
    });
    expect(result.status).toBe("saved");
    expect(JSON.parse(await read(file))).toEqual({ keep: 1 });
  });

  test("turning attribution off keeps the other attribution keys", async () => {
    const file = path.join(defaultDir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ attribution: { sessionUrl: true } }));
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    await writeBehavior(profile, version, { attribution: false });
    expect(JSON.parse(await read(file))).toEqual({
      attribution: { sessionUrl: true, commit: "", pr: "" },
    });
  });

  test("makes the file when there is none", async () => {
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    await writeBehavior(profile, version, { language: "한국어" });
    expect(JSON.parse(await read(path.join(defaultDir, "settings.json")))).toEqual({
      language: "한국어",
    });
  });

  test("a broken file is reported and never overwritten", async () => {
    const file = path.join(defaultDir, "settings.json");
    await fs.writeFile(file, '{ "model": "opus", ');
    const profile = claudeProfile("");
    const got = await readBehavior(profile);
    expect(got.broken).not.toBeNull();
    const result = await writeBehavior(profile, got.version, { language: "x" });
    expect(result.status).toBe("broken");
    expect(await read(file)).toBe('{ "model": "opus", ');
    await fs.writeFile(file, "[1]");
    expect((await readBehavior(profile)).broken).not.toBeNull();
  });

  test("a file changed from outside since it was read is not overwritten", async () => {
    const file = path.join(defaultDir, "settings.json");
    await fs.writeFile(file, '{"model":"opus"}');
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    await fs.writeFile(file, '{"model":"haiku","theme":"light"}');
    expect(await writeBehavior(profile, version, { language: "x" })).toEqual({
      status: "conflict",
    });
    expect(await read(file)).toBe('{"model":"haiku","theme":"light"}');
    const again = await readBehavior(profile);
    expect(again.version).not.toBe(version);
    expect((await writeBehavior(profile, again.version, { language: "x" })).status).toBe("saved");
  });

  test("a value of a shape it cannot change is refused", async () => {
    const file = path.join(defaultDir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ permissions: "strict" }));
    const profile = claudeProfile("");
    const { version } = await readBehavior(profile);
    const result = await writeBehavior(profile, version, { permissionMode: "plan" });
    expect(result).toEqual({ status: "unsupported", fields: ["permissionMode"] });
  });
});

describe.if(posix)("a file shared with the default folder", () => {
  test("a symbolic link stays a link, and the default's file is the one written", async () => {
    const real = path.join(defaultDir, "settings.json");
    const link = path.join(ownDir, "settings.json");
    await fs.writeFile(real, '{"theme":"dark"}\n');
    await fs.symlink(real, link);
    const profile = claudeProfile(ownDir, ["settings.json"]);
    const got = await readBehavior(profile);
    expect(got.shared).toBe(true);
    await writeBehavior(profile, got.version, { language: "ko" });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(link)).toBe(real);
    expect(JSON.parse(await read(real))).toEqual({ theme: "dark", language: "ko" });
    expect(JSON.parse(await read(link)).language).toBe("ko");
  });

  test("a hard link stays one: written in place", async () => {
    const real = path.join(defaultDir, "config.toml");
    const link = path.join(ownDir, "config.toml");
    await fs.writeFile(real, '# mine\nmodel = "a"\n');
    await fs.link(real, link);
    const profile = codexProfile(ownDir, ["config.toml"]);
    const got = await readBehavior(profile);
    expect(got.shared).toBe(true);
    const result = await writeBehavior(profile, got.version, { approvalPolicy: "never" });
    expect(result.status).toBe("saved");
    const [a, b] = await Promise.all([fs.stat(real), fs.stat(link)]);
    expect(a.ino).toBe(b.ino);
    expect(a.nlink).toBe(2);
    expect(await read(real)).toBe('# mine\nmodel = "a"\napproval_policy = "never"\n');
  });

  test("a link to a default file not there yet is written through", async () => {
    const real = path.join(defaultDir, "settings.json");
    const link = path.join(ownDir, "settings.json");
    await fs.symlink(real, link);
    const profile = claudeProfile(ownDir, ["settings.json"]);
    const got = await readBehavior(profile);
    expect(got.exists).toBe(false);
    await writeBehavior(profile, got.version, { language: "ko" });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await read(real))).toEqual({ language: "ko" });
  });

  test("a profile that shares the file and has no link yet gets one on its first read", async () => {
    await fs.writeFile(path.join(defaultDir, "settings.json"), '{"model":"opus"}');
    const profile = claudeProfile(ownDir, ["settings.json"]);
    const got = await readBehavior(profile, { prepare: true });
    expect(got.shared).toBe(true);
    expect(got.values.model).toBe("opus");
    expect((await fs.lstat(path.join(ownDir, "settings.json"))).isSymbolicLink()).toBe(true);
  });

  test("a file of its own is its own", async () => {
    await fs.writeFile(path.join(defaultDir, "settings.json"), '{"model":"opus"}');
    await fs.writeFile(path.join(ownDir, "settings.json"), '{"model":"haiku"}');
    const profile = claudeProfile(ownDir, []);
    const got = await readBehavior(profile);
    expect(got.shared).toBe(false);
    await writeBehavior(profile, got.version, { language: "ko" });
    expect(JSON.parse(await read(path.join(defaultDir, "settings.json")))).toEqual({
      model: "opus",
    });
  });

  test("unsharing copies the content in the link's place and leaves the default alone", async () => {
    const real = path.join(defaultDir, "settings.json");
    const link = path.join(ownDir, "settings.json");
    await fs.writeFile(real, '{"theme":"dark"}\n');
    await fs.symlink(real, link);
    const profile = claudeProfile(ownDir, ["settings.json"]);
    await unshareBehaviorFile(profile);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
    expect(await read(link)).toBe('{"theme":"dark"}\n');
    const own = await readBehavior({ ...profile, shared: [] });
    expect(own.shared).toBe(false);
    await writeBehavior({ ...profile, shared: [] }, own.version, { language: "ko" });
    expect(await read(real)).toBe('{"theme":"dark"}\n');
    expect(JSON.parse(await read(link))).toEqual({ theme: "dark", language: "ko" });
  });

  test("unsharing a hard link makes a file of its own too", async () => {
    const real = path.join(defaultDir, "config.toml");
    const link = path.join(ownDir, "config.toml");
    await fs.writeFile(real, 'model = "a"\n');
    await fs.link(real, link);
    const profile = codexProfile(ownDir, ["config.toml"]);
    await unshareBehaviorFile(profile);
    expect((await fs.stat(link)).ino).not.toBe((await fs.stat(real)).ino);
    expect(await read(link)).toBe('model = "a"\n');
    expect((await fs.stat(real)).nlink).toBe(1);
  });

  test("after unsharing, prepare keeps the profile's own file", async () => {
    const { prepareLocalProfile } = await import(
      "../../../../../src/main/features/agent-profiles/local"
    );
    const real = path.join(defaultDir, "settings.json");
    const link = path.join(ownDir, "settings.json");
    await fs.writeFile(real, '{"a":1}');
    await fs.symlink(real, link);
    await unshareBehaviorFile(claudeProfile(ownDir, ["settings.json"]));
    await prepareLocalProfile(claudeProfile(ownDir, []));
    expect(await read(link)).toBe('{"a":1}');
  });

  test("the default profile's file is never shared", async () => {
    await fs.writeFile(path.join(defaultDir, "settings.json"), "{}");
    expect((await readBehavior(claudeProfile(""))).shared).toBe(false);
  });
});

describe("config.toml", () => {
  test("reads and writes the fields, keeping comments and other tables", async () => {
    const file = path.join(defaultDir, "config.toml");
    const text = [
      "# my codex",
      'model = "gpt-5"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.docs]",
      'command = "docs"',
      "args = [",
      '  "--x", # why',
      "]",
      "",
    ].join("\n");
    await fs.writeFile(file, text);
    const profile = codexProfile("");
    const got = await readBehavior(profile);
    expect(got.values).toEqual({ codexModel: "gpt-5", approvalPolicy: "on-request" });
    const result = await writeBehavior(profile, got.version, {
      approvalPolicy: "never",
      sandboxNetwork: true,
      autoCompactLimit: 100000,
      reasoningSummary: "concise",
      codexModel: null,
    });
    expect(result.status).toBe("saved");
    expect(await read(file)).toBe(
      [
        "# my codex",
        'approval_policy = "never"',
        "model_auto_compact_token_limit = 100000",
        'model_reasoning_summary = "concise"',
        "",
        "[mcp_servers.docs]",
        'command = "docs"',
        "args = [",
        '  "--x", # why',
        "]",
        "",
        "[sandbox_workspace_write]",
        "network_access = true",
        "",
      ].join("\n"),
    );
    const next = await readBehavior(profile);
    await writeBehavior(profile, next.version, { sandboxNetwork: false });
    expect(await read(file)).not.toContain("network_access");
  });

  test("a key that is a table or an array is not changed", async () => {
    const file = path.join(defaultDir, "config.toml");
    const text = "[approval_policy.granular]\nx = true\n";
    await fs.writeFile(file, text);
    const profile = codexProfile("");
    const got = await readBehavior(profile);
    expect(got.unsupported).toEqual(["approvalPolicy"]);
    expect(await writeBehavior(profile, got.version, { approvalPolicy: "never" })).toEqual({
      status: "unsupported",
      fields: ["approvalPolicy"],
    });
    expect(await read(file)).toBe(text);
  });

  test("a broken file is reported and never overwritten", async () => {
    const file = path.join(defaultDir, "config.toml");
    await fs.writeFile(file, "model = \n[x\n");
    const profile = codexProfile("");
    const got = await readBehavior(profile);
    expect(got.broken).not.toBeNull();
    expect((await writeBehavior(profile, got.version, { codexModel: "a" })).status).toBe("broken");
    expect(await read(file)).toBe("model = \n[x\n");
  });

  test("a change from outside is noticed", async () => {
    const file = path.join(defaultDir, "config.toml");
    await fs.writeFile(file, 'model = "a"\n');
    const profile = codexProfile("");
    const got = await readBehavior(profile);
    await fs.writeFile(file, 'model = "b"\n');
    expect((await readBehavior(profile)).version).not.toBe(got.version);
    expect((await writeBehavior(profile, got.version, { codexModel: "c" })).status).toBe(
      "conflict",
    );
    expect(await read(file)).toBe('model = "b"\n');
  });
});
