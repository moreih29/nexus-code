import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { API, APP } from "./fake-services";
import { bodyOf, profileDirs, profileFixture } from "./profile-test-fixture";

const dirOf = profileDirs();
const fixture = () => profileFixture(dirOf());
const PROJECTS = join("~", "projects");

test("profiles default shows each agent's default and changes one with approval", async () => {
  const { app, cli, config, changes } = fixture();
  const shown = await cli(["chat", "profiles", "default", "--json"]);
  expect(JSON.parse(shown.stdout).defaults).toEqual([
    { agent: "claude", id: "claude-default", name: "default" },
    { agent: "codex", id: "codex-default", name: "default" },
  ]);
  expect(app.asked).toEqual([]);

  app.answers.push("once");
  const set = await cli(["chat", "profiles", "default", "Build", "--json"]);
  expect(set.exitCode).toBe(0);
  expect(JSON.parse(set.stdout)).toMatchObject({ agent: "codex", id: "codex-build001" });
  expect(config().defaults).toEqual({ codex: "codex-build001" });
  expect(changes).toHaveLength(1);
  expect(app.asked[0]?.change).toMatchObject({
    kind: "profileDefault",
    detail: "Codex",
    eachTime: true,
    profileDefault: { agent: "codex", from: "default", to: "Build" },
  });
  expect(bodyOf(app.asked[0]?.change)).toBe("에이전트 Codex\n기본 프로필 default → Build");
});

test("profiles default refuses an unknown profile, the current default, a denial and --device", async () => {
  const { app, cli, config } = fixture();
  const unknown = await cli(["chat", "profiles", "default", "Nope"]);
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr).toContain('no profile "Nope"');
  const same = await cli(["chat", "profiles", "default", "default", "--agent", "claude"]);
  expect(same.stderr).toContain("already the default claude profile");
  const ambiguous = await cli(["chat", "profiles", "default", "Gateway"]);
  expect(ambiguous.stderr).toContain("more than one profile");
  const device = await cli(["chat", "profiles", "default", "Work", "--device", "Mini"]);
  expect(device.exitCode).toBe(2);
  expect(device.stderr).toContain("this computer's profiles only; leave out --device");
  expect(app.asked).toEqual([]);
  app.answers.push("deny");
  const denied = await cli(["chat", "profiles", "default", "Work"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("the user did not allow it");
  expect(config().defaults).toEqual({});
});

test("rules set adds a folder rule, changes it and lists it with what this workspace uses", async () => {
  const { app, cli, config } = fixture();
  await mkdir(join(dirOf(), "projects", "app"), { recursive: true });
  app.answers.push("once");
  const added = await cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--folder",
    "projects",
    "--profile",
    "Work",
    "--json",
  ]);
  expect(added.exitCode).toBe(0);
  const rule = config().rules[0];
  expect(rule).toMatchObject({
    target: { kind: "folder", path: join(dirOf(), "projects") },
    claude: "claude-work0001",
  });
  expect(JSON.parse(added.stdout)).toMatchObject({
    target: { kind: "folder", name: PROJECTS },
    claude: { id: "claude-work0001", name: "Work" },
    added: true,
    changed: ["claude"],
  });
  expect(app.asked[0]?.change).toMatchObject({
    kind: "profileRule",
    detail: PROJECTS,
    eachTime: true,
    profileRule: { target: { kind: "folder", name: PROJECTS }, applies: 0 },
  });
  expect(bodyOf(app.asked[0]?.change)).toBe(
    `폴더 ${PROJECTS} · 하위 폴더 포함\nClaude Work\n지금 적용되는 워크스페이스 0개`,
  );

  app.answers.push("once");
  const codex = await cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--folder",
    `${join(dirOf(), "projects")}/`,
    "--agent",
    "codex",
    "--profile",
    "Gateway",
  ]);
  expect(codex.exitCode).toBe(0);
  expect(config().rules).toHaveLength(1);
  expect(config().rules[0]).toMatchObject({ claude: "claude-work0001", codex: "codex-gate0001" });
  expect(bodyOf(app.asked[1]?.change)).toContain("Codex 기본값 사용 → Gateway");

  app.answers.push("once");
  const inherit = await cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--folder",
    "projects",
    "--agent",
    "claude",
    "--inherit",
  ]);
  expect(inherit.exitCode).toBe(0);
  expect(config().rules[0]).toEqual({
    id: rule?.id as string,
    target: { kind: "folder", path: join(dirOf(), "projects") },
    codex: "codex-gate0001",
  });
  expect(bodyOf(app.asked[2]?.change)).toContain("Claude Work → 기본값 사용");

  const listed = await cli(["chat", "profiles", "rules", "--json"]);
  const view = JSON.parse(listed.stdout);
  expect(view.rules).toEqual([
    {
      id: rule?.id,
      target: { kind: "folder", path: join(dirOf(), "projects"), name: PROJECTS },
      codex: { id: "codex-gate0001", name: "Gateway" },
      applies: 0,
    },
  ]);
  expect(view.workspace).toMatchObject({
    id: APP,
    claude: { id: "claude-default", source: "default" },
    codex: { id: "codex-default", source: "default" },
  });
  const text = await cli(["chat", "profiles", "rules"]);
  expect(text.stdout).toContain(PROJECTS);
  expect(text.stdout).toContain("inherit");
  expect(text.stdout).toContain("This workspace (app): Claude default (default)");
});

test("rules set refuses bad targets and profiles before asking", async () => {
  const { app, cli, config } = fixture();
  await writeFile(
    join(dirOf(), "ssh-config"),
    "Host build-box\n  HostName 127.0.0.1\nHost *.corp\n",
  );
  const run = (args: string[]) => cli(["chat", "profiles", "rules", "set", ...args]);
  const cases: [string[], string][] = [
    [["--profile", "Work"], "Give --folder PATH, --ssh HOST or --workspace WS"],
    [["--folder", "missing", "--profile", "Work"], "is not a folder"],
    [["--ssh", "other-host", "--profile", "Work"], "is not a host of ~/.ssh/config"],
    [["--ssh", "*.corp", "--profile", "Work"], "without spaces or wildcards"],
    [["--workspace", "fix-login", "--profile", "Work"], "follows its parent workspace's rule"],
    [["--workspace", "app", "--profile", "Nope"], 'no profile "Nope"'],
    [["--workspace", "app", "--agent", "codex", "--profile", "Work"], "is a claude profile"],
    [["--workspace", "app", "--inherit"], "--inherit needs --agent"],
    [["--workspace", "app", "--profile", "Work", "--inherit"], "Give --profile NAME or --inherit"],
    [["--workspace", "app", "--folder", ".", "--profile", "Work"], "Give one of --folder"],
    [["--workspace", "app", "--agent", "claude", "--inherit"], "No rule for this target"],
    [["--workspace", "app", "--profile", "Work", "--device", "Mini"], "leave out --device"],
  ];
  for (const [args, message] of cases) {
    const result = await run(args);
    expect(result.exitCode, args.join(" ")).not.toBe(0);
    expect(result.stderr, args.join(" ")).toContain(message);
  }
  expect(app.asked).toEqual([]);
  expect(config().rules).toEqual([]);

  app.answers.push("once");
  const ssh = await run(["--ssh", "BUILD-BOX", "--profile", "Work"]);
  expect(ssh.exitCode).toBe(0);
  expect(config().rules[0]?.target).toEqual({ kind: "ssh", host: "build-box" });
  const again = await run(["--ssh", "build-box", "--profile", "Work"]);
  expect(again.stderr).toContain("Nothing to change");
  expect(app.asked).toHaveLength(1);
});

test("a rule for another workspace follows the setting for changing other workspaces", async () => {
  const denyFixture = fixture();
  denyFixture.app.settings.crossWorkspace = "deny";
  const denied = await denyFixture.cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--workspace",
    "api",
    "--profile",
    "Work",
  ]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("changing other workspaces is turned off");
  expect(denyFixture.app.asked).toEqual([]);
  expect(denyFixture.config().rules).toEqual([]);

  const allow = fixture();
  allow.app.settings.crossWorkspace = "allow";
  allow.app.answers.push("once");
  const allowed = await allow.cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--workspace",
    "api",
    "--profile",
    "Work",
  ]);
  expect(allowed.exitCode).toBe(0);
  expect(allow.app.asked).toHaveLength(1);
  expect(allow.app.asked[0]).toMatchObject({
    toWorkspaceId: API,
    change: { kind: "profileRule", eachTime: true },
  });

  const ask = fixture();
  ask.app.answers.push("once", "once");
  const asked = await ask.cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--workspace",
    "api",
    "--profile",
    "Work",
  ]);
  expect(asked.exitCode).toBe(0);
  expect(ask.app.asked.map(({ change }) => change.eachTime === true)).toEqual([false, true]);
  expect(ask.config().rules[0]).toMatchObject({
    target: { kind: "workspace", workspaceId: API },
    claude: "claude-work0001",
  });

  const own = fixture();
  own.app.settings.crossWorkspace = "deny";
  own.app.answers.push("once");
  const mine = await own.cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--workspace",
    "app",
    "--profile",
    "Work",
    "--json",
  ]);
  expect(mine.exitCode).toBe(0);
  expect(own.app.asked).toHaveLength(1);
  expect(JSON.parse(mine.stdout).workspace.claude).toMatchObject({
    id: "claude-work0001",
    source: "workspace",
  });
  expect(JSON.parse(mine.stdout).applies).toBe(1);
});

test("rules remove takes a rule id or target, asks each time and keeps it on denial", async () => {
  const { app, cli, config, state } = fixture();
  state.commitState({
    agentProfiles: {
      ...config(),
      rules: [
        {
          id: "rule-aaaa-1111",
          target: { kind: "workspace", workspaceId: APP },
          claude: "claude-work0001",
        },
        {
          id: "rule-bbbb-2222",
          target: { kind: "ssh", host: "build-box" },
          codex: "codex-build001",
        },
      ],
    },
  });
  app.answers.push("deny");
  const denied = await cli(["chat", "profiles", "rules", "remove", "rule-aaaa"]);
  expect(denied.exitCode).toBe(1);
  expect(config().rules).toHaveLength(2);
  expect(bodyOf(app.asked[0]?.change)).toBe(
    "워크스페이스 app\nClaude Work\n규칙 삭제\n지금 적용되는 워크스페이스 1개",
  );
  app.answers.push("once");
  const removed = await cli([
    "chat",
    "profiles",
    "rules",
    "remove",
    "--ssh",
    "BUILD-BOX",
    "--json",
  ]);
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout)).toMatchObject({ id: "rule-bbbb-2222", removed: true });
  expect(config().rules.map(({ id }) => id)).toEqual(["rule-aaaa-1111"]);
  const missing = await cli(["chat", "profiles", "rules", "remove", "--folder", "nowhere"]);
  expect(missing.stderr).toContain("No rule for this target");
  const both = await cli(["chat", "profiles", "rules", "remove", "rule-aaaa", "--ssh", "x"]);
  expect(both.stderr).toContain("Give a <rule> id or one of");
});

test("rule and default changes made while the approval waits are not overwritten", async () => {
  const { app, cli, config, state } = fixture();
  const ask = app.services.askUser;
  const moved: AgentProfiles["defaults"][] = [
    { claude: "claude-gate0001" },
    { claude: "claude-gate0001", codex: "codex-build001" },
  ];
  app.services = {
    ...app.services,
    askUser: async (request, signal) => {
      state.commitState({ agentProfiles: { ...config(), defaults: moved.shift() ?? {} } });
      await ask(request, signal);
    },
  };
  app.answers.push("once", "once");
  const rule = await cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--workspace",
    "app",
    "--profile",
    "Work",
  ]);
  expect(rule.exitCode).toBe(1);
  expect(rule.stderr).toContain("changed while waiting for approval");
  expect(config().rules).toEqual([]);
  const def = await cli(["chat", "profiles", "default", "Work"]);
  expect(def.stderr).toContain("changed while waiting for approval");
  expect(config().defaults).toEqual({ claude: "claude-gate0001", codex: "codex-build001" });
});

test("nexus help and each command's help name the rule commands and their approval", async () => {
  const { cli } = fixture();
  const help = await cli(["help"]);
  for (const path of [
    "chat profiles default",
    "chat profiles rules",
    "chat profiles rules set",
    "chat profiles rules remove",
  ]) {
    expect(help.stdout).toContain(path);
  }
  const set = await cli(["chat", "profiles", "rules", "set", "--help"]);
  expect(set.stdout).toContain("--inherit");
  expect(set.stdout).toContain("follows the setting for changing other workspaces");
  const rules = await cli(["chat", "profiles", "rules", "--help"]);
  expect(rules.stdout).toContain("a workspace rule wins over a deeper folder rule");
});
