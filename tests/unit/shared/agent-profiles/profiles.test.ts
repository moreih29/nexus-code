import { describe, expect, test } from "bun:test";
import {
  type AgentProfile,
  type AgentProfiles,
  AgentProfilesSchema,
  defaultProfileId,
  EMPTY_AGENT_PROFILES,
  folderDepth,
  isDefaultDir,
  type ProfileWorkspace,
  profileOf,
  profilesOf,
  resolveProfile,
  suggestedProfileDir,
  withoutProfile,
  withRuleProfile,
} from "../../../../src/shared/agent-profiles/profiles";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const WS_TASK = "33333333-3333-4333-8333-333333333333";

const personal: AgentProfile = {
  id: "claude-personal",
  agent: "claude",
  name: "Personal",
  color: "violet",
  dir: "~/.claude-personal",
};
const test2: AgentProfile = {
  id: "claude-test",
  agent: "claude",
  name: "Test",
  color: "gray",
  dir: "~/.claude-test",
};
const codex2: AgentProfile = {
  id: "codex-2",
  agent: "codex",
  name: "Second",
  color: "rose",
  dir: "~/.codex-2",
};

function config(partial: Partial<AgentProfiles> = {}): AgentProfiles {
  return { ...EMPTY_AGENT_PROFILES, profiles: [personal, test2, codex2], ...partial };
}

const local = (id: string, rootPath: string): ProfileWorkspace => ({
  id,
  location: { kind: "local", rootPath },
});
const ssh = (id: string, host: string, configAlias?: string): ProfileWorkspace => ({
  id,
  location: {
    kind: "ssh",
    host,
    remotePath: "/home/me/train",
    authMode: "interactive",
    ...(configAlias ? { configAlias } : {}),
  },
});

describe("profilesOf", () => {
  test("the default-folder profile comes first, with no folder, even when stored with one", () => {
    const stored = { ...personal, id: defaultProfileId("claude"), name: "Work", dir: "~/x" };
    const list = profilesOf(config({ profiles: [stored, personal, codex2] }), "claude");
    expect(list.map((p) => p.id)).toEqual(["claude-default", "claude-personal"]);
    expect(list[0]?.name).toBe("Work");
    expect(list[0]?.dir).toBe("");
  });

  test("an id the agent has not falls back to its default profile", () => {
    expect(profileOf(config(), "claude", "codex-2").id).toBe("claude-default");
    expect(profileOf(config(), "claude", undefined).id).toBe("claude-default");
  });
});

describe("resolveProfile", () => {
  const options = { home: "/Users/me" };

  test("no rules: the agent's default, else the default profile", () => {
    const ws = local(WS_A, "/Users/me/work/app");
    expect(resolveProfile(config(), "claude", ws, options).profile.id).toBe("claude-default");
    const withDefault = config({ defaults: { claude: "claude-personal" } });
    const resolved = resolveProfile(withDefault, "claude", ws, options);
    expect(resolved.profile.id).toBe("claude-personal");
    expect(resolved.source).toEqual({ kind: "default" });
  });

  test("the deepest folder wins over a shallower one, and folders take ~", () => {
    const c = config({
      rules: [
        { id: "r1", target: { kind: "folder", path: "~/work" }, claude: "claude-personal" },
        { id: "r2", target: { kind: "folder", path: "/Users/me/work/app" }, claude: "claude-test" },
      ],
    });
    expect(resolveProfile(c, "claude", local(WS_A, "/Users/me/work/app/sub"), options).profile.id).toBe(
      "claude-test",
    );
    expect(resolveProfile(c, "claude", local(WS_A, "/Users/me/work/other"), options).source).toEqual({
      kind: "folder",
      ruleId: "r1",
    });
    // A sibling whose name starts the same is not inside.
    expect(resolveProfile(c, "claude", local(WS_A, "/Users/me/workshop"), options).source).toEqual({
      kind: "default",
    });
  });

  test("a workspace's own rule beats a folder, and a folder beats an SSH host", () => {
    const c = config({
      rules: [
        { id: "f", target: { kind: "folder", path: "/Users/me" }, claude: "claude-personal" },
        { id: "w", target: { kind: "workspace", workspaceId: WS_A }, claude: "claude-test" },
        { id: "s", target: { kind: "ssh", host: "gpu-01" }, claude: "claude-test" },
      ],
    });
    expect(resolveProfile(c, "claude", local(WS_A, "/Users/me/a"), options).source).toEqual({
      kind: "workspace",
      ruleId: "w",
    });
    expect(resolveProfile(c, "claude", local(WS_B, "/Users/me/b"), options).source).toEqual({
      kind: "folder",
      ruleId: "f",
    });
    expect(resolveProfile(c, "claude", ssh(WS_B, "10.0.0.5", "GPU-01"), options).source).toEqual({
      kind: "ssh",
      ruleId: "s",
    });
  });

  test("a rule that leaves the agent out, or names a profile gone, passes to the next", () => {
    const c = config({
      defaults: { codex: "codex-2" },
      rules: [
        { id: "w", target: { kind: "workspace", workspaceId: WS_A }, claude: "claude-gone" },
        { id: "f", target: { kind: "folder", path: "/Users/me" }, claude: "claude-personal" },
      ],
    });
    const ws = local(WS_A, "/Users/me/a");
    expect(resolveProfile(c, "claude", ws, options).source).toEqual({ kind: "folder", ruleId: "f" });
    expect(resolveProfile(c, "codex", ws, options)).toMatchObject({
      profile: { id: "codex-2" },
      source: { kind: "default" },
    });
  });

  test("a task follows the workspace it was made from", () => {
    const c = config({
      rules: [{ id: "w", target: { kind: "workspace", workspaceId: WS_A }, claude: "claude-test" }],
    });
    const task: ProfileWorkspace = {
      ...local(WS_TASK, "/Users/me/.worktrees/app-fix"),
      parent: { id: WS_A, location: { kind: "local", rootPath: "/Users/me/app" } },
    };
    expect(resolveProfile(c, "claude", task, options).profile.id).toBe("claude-test");
  });

  test("folders compare without case on Windows, with either slash", () => {
    const c = config({
      rules: [{ id: "f", target: { kind: "folder", path: "C:\\Work" }, claude: "claude-test" }],
    });
    const ws = local(WS_A, "c:/work/app");
    expect(resolveProfile(c, "claude", ws, { windows: true }).profile.id).toBe("claude-test");
    expect(resolveProfile(c, "claude", ws, {}).profile.id).toBe("claude-default");
  });
});

describe("edits", () => {
  test("a rule given a profile is made; given null for its last agent, it goes", () => {
    let id = 0;
    const newId = () => `rule-${++id}`;
    const target = { kind: "workspace", workspaceId: WS_A } as const;
    let c = withRuleProfile(config(), target, "claude", "claude-personal", newId);
    expect(c.rules).toEqual([{ id: "rule-1", target, claude: "claude-personal" }]);
    c = withRuleProfile(c, target, "codex", "codex-2", newId);
    expect(c.rules).toEqual([{ id: "rule-1", target, claude: "claude-personal", codex: "codex-2" }]);
    c = withRuleProfile(c, target, "claude", null, newId);
    c = withRuleProfile(c, target, "codex", null, newId);
    expect(c.rules).toEqual([]);
    // Settings keeps a rule it is still filling in.
    c = withRuleProfile(c, target, "codex", null, newId, {}, true);
    expect(c.rules).toEqual([{ id: "rule-2", target }]);
  });

  test("removing a profile takes it out of rules and defaults, but not a rule left empty by the user", () => {
    const c = withoutProfile(
      config({
        defaults: { claude: "claude-personal" },
        rules: [
          { id: "a", target: { kind: "ssh", host: "h" }, claude: "claude-personal" },
          { id: "b", target: { kind: "ssh", host: "i" }, claude: "claude-personal", codex: "codex-2" },
          { id: "c", target: { kind: "ssh", host: "j" } },
        ],
      }),
      "claude-personal",
    );
    expect(c.profiles.map((p) => p.id)).toEqual(["claude-test", "codex-2"]);
    expect(c.defaults).toEqual({});
    expect(c.rules).toEqual([
      { id: "b", target: { kind: "ssh", host: "i" }, codex: "codex-2" },
      { id: "c", target: { kind: "ssh", host: "j" } },
    ]);
  });

  test("the default profile cannot be removed", () => {
    const c = config();
    expect(withoutProfile(c, "claude-default")).toBe(c);
  });
});

describe("folders", () => {
  test("folderDepth", () => {
    expect(folderDepth("/a/b", "/a/b")).toBe(2);
    expect(folderDepth("/a/b/", "/a/b/c")).toBe(2);
    expect(folderDepth("/a/b", "/a/bc")).toBe(-1);
    expect(folderDepth("/", "/x")).toBe(0);
  });

  test("a new profile's folder is named after it, apart from those taken", () => {
    expect(suggestedProfileDir("claude", "Personal", [])).toBe("~/.claude-personal");
    expect(suggestedProfileDir("codex", "개인", [])).toBe("~/.codex-profile");
    expect(suggestedProfileDir("claude", "Work", ["~/.claude-work"])).toBe("~/.claude-work-2");
  });

  test("the default folder is the default profile's alone", () => {
    expect(isDefaultDir("claude", "~/.claude")).toBe(true);
    expect(isDefaultDir("claude", "/Users/me/.claude/", { home: "/Users/me" })).toBe(true);
    expect(isDefaultDir("claude", "~/.claude-personal")).toBe(false);
    expect(isDefaultDir("codex", "~/.claude")).toBe(false);
  });
});

describe("schema", () => {
  test("an entry it cannot read is dropped, not the whole config", () => {
    const parsed = AgentProfilesSchema.parse({
      profiles: [personal, { id: "x", agent: "gemini", name: "", color: "", dir: "" }],
      rules: [
        { id: "r", target: { kind: "folder", path: "/a" }, claude: "claude-personal" },
        { id: "q", target: { kind: "cluster", name: "k8s" } },
      ],
      defaults: {},
    });
    expect(parsed.profiles.map((p) => p.id)).toEqual(["claude-personal"]);
    expect(parsed.rules.map((r) => r.id)).toEqual(["r"]);
  });
});
