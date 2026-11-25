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
  expect(device.stderr).toContain(
    "--device is not taken here: this command acts on this computer only",
  );
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
    [["--workspace", "app", "--profile", "Work", "--device", "Mini"], "--device is not taken here"],
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
  ask.app.answers.push("once");
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
  expect(ask.app.asked).toHaveLength(1);
  expect(ask.app.asked[0]).toMatchObject({
    toWorkspaceId: API,
    otherWorkspaces: true,
    change: { kind: "profileRule", eachTime: true, profileRule: { applies: 1, others: 1 } },
  });
  expect(bodyOf(ask.app.asked[0]?.change)).toBe(
    "워크스페이스 api\nClaude Work\n지금 적용되는 워크스페이스 1개\n다른 워크스페이스 1개 포함",
  );
  expect(bodyOf(ask.app.asked[0]?.change, "en")).toContain("Includes 1 other workspace");
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
  expect(own.app.asked[0]?.otherWorkspaces).toBeUndefined();
  expect(bodyOf(own.app.asked[0]?.change)).not.toContain("다른 워크스페이스");
  expect(JSON.parse(mine.stdout).workspace.claude).toMatchObject({
    id: "claude-work0001",
    source: "workspace",
  });
  expect(JSON.parse(mine.stdout).applies).toBe(1);
});

async function placeWorkspaces(app: ReturnType<typeof fixture>["app"]) {
  const root = join(dirOf(), "projects");
  for (const [index, name] of ["app", "api"].entries()) {
    const rootPath = join(root, name);
    await mkdir(rootPath, { recursive: true });
    const workspace = app.workspaces[index] as (typeof app.workspaces)[number];
    workspace.location = { kind: "local", rootPath };
    workspace.rootPath = rootPath;
  }
}

test("folder and SSH rules that reach another workspace follow the cross-workspace setting", async () => {
  const set = ["chat", "profiles", "rules", "set", "--profile", "Work"];
  const denied = fixture();
  await placeWorkspaces(denied.app);
  denied.app.settings.crossWorkspace = "deny";
  const folder = await denied.cli([...set, "--folder", "projects"]);
  expect(folder.exitCode).toBe(1);
  expect(folder.stderr).toContain("changing other workspaces is turned off");
  expect(denied.app.asked).toEqual([]);
  expect(denied.config().rules).toEqual([]);
  denied.app.answers.push("once");
  const ownFolder = await denied.cli([...set, "--folder", join("projects", "app")]);
  expect(ownFolder.exitCode).toBe(0);
  expect(denied.app.asked).toHaveLength(1);
  expect(denied.app.asked[0]?.otherWorkspaces).toBeUndefined();
  const ruleId = denied.config().rules[0]?.id as string;
  denied.state.commitState({
    agentProfiles: {
      ...denied.config(),
      rules: [
        ...denied.config().rules,
        {
          id: "rule-wide-0001",
          target: { kind: "folder", path: join(dirOf(), "projects") },
          codex: "codex-build001",
        },
      ],
    },
  });
  const removeWide = await denied.cli(["chat", "profiles", "rules", "remove", "rule-wide"]);
  expect(removeWide.exitCode).toBe(1);
  expect(removeWide.stderr).toContain("changing other workspaces is turned off");
  expect(denied.config().rules.map(({ id }) => id)).toEqual([ruleId, "rule-wide-0001"]);
  expect(denied.app.asked).toHaveLength(1);

  const sshHost = fixture();
  (sshHost.app.workspaces[1] as (typeof sshHost.app.workspaces)[number]).location = {
    kind: "ssh",
    host: "build-box",
    remotePath: "/srv/api",
  };
  sshHost.app.settings.crossWorkspace = "deny";
  const ssh = await sshHost.cli([...set, "--ssh", "build-box"]);
  expect(ssh.exitCode).toBe(1);
  expect(ssh.stderr).toContain("changing other workspaces is turned off");
  expect(sshHost.app.asked).toEqual([]);

  const asking = fixture();
  await placeWorkspaces(asking.app);
  asking.app.answers.push("once");
  const asked = await asking.cli([...set, "--folder", "projects"]);
  expect(asked.exitCode).toBe(0);
  expect(asking.app.asked).toHaveLength(1);
  expect(asking.app.asked[0]).toMatchObject({
    toWorkspaceId: APP,
    otherWorkspaces: true,
    change: { kind: "profileRule", eachTime: true, profileRule: { applies: 2, others: 1 } },
  });
  expect(bodyOf(asking.app.asked[0]?.change)).toBe(
    `폴더 ${PROJECTS} · 하위 폴더 포함\nClaude Work\n지금 적용되는 워크스페이스 2개\n다른 워크스페이스 1개 포함`,
  );
  asking.app.answers.push("deny");
  const refused = await asking.cli(["chat", "profiles", "rules", "remove", "--folder", "projects"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("the user did not allow it");
  expect(asking.app.asked).toHaveLength(2);
  expect(asking.config().rules).toHaveLength(1);

  const allowing = fixture();
  await placeWorkspaces(allowing.app);
  allowing.app.settings.crossWorkspace = "allow";
  allowing.app.answers.push("once");
  const allowed = await allowing.cli([...set, "--folder", "projects"]);
  expect(allowed.exitCode).toBe(0);
  expect(allowing.app.asked).toHaveLength(1);
  expect(allowing.app.asked[0]).toMatchObject({
    otherWorkspaces: true,
    change: { eachTime: true },
  });
});

test("a workspace that a rule starts to reach while the approval waits refuses the change", async () => {
  const { app, cli, config } = fixture();
  await placeWorkspaces(app);
  const api = app.workspaces[1] as (typeof app.workspaces)[number];
  api.location = { kind: "local", rootPath: "/elsewhere/api" };
  const ask = app.services.askUser;
  app.services = {
    ...app.services,
    askUser: async (request, signal) => {
      api.location = { kind: "local", rootPath: join(dirOf(), "projects", "api") };
      await ask(request, signal);
    },
  };
  app.answers.push("once");
  const result = await cli([
    "chat",
    "profiles",
    "rules",
    "set",
    "--folder",
    "projects",
    "--profile",
    "Work",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("The workspaces the rule applies to changed while waiting");
  expect(app.asked[0]?.otherWorkspaces).toBeUndefined();
  expect(config().rules).toEqual([]);
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
