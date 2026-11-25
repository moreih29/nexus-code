import { afterEach, beforeEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import i18next from "i18next";
import { ConnectionKeys } from "../../../../src/main/features/agent-profiles/connection-keys";
import { createProfileConnections } from "../../../../src/main/features/agent-profiles/connection-save";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { chatProfilesEdit } from "../../../../src/main/features/cli/commands/chat-profiles-edit";
import {
  chatProfilesRules,
  chatProfilesRulesRemove,
  chatProfilesRulesSet,
  type RulesOptions,
} from "../../../../src/main/features/cli/commands/chat-profiles-rules";
import { type CliCommand, runCli } from "../../../../src/main/features/cli/registry";
import { keptInMemory } from "../../../../src/main/features/remote/sealed-file";
import type { AgentProfile, AgentProfiles } from "../../../../src/shared/agent-profiles/profiles";
import { type ConsentChange, consentDetailsOf } from "../../../../src/shared/cli/consent-copy";
import { openTestState } from "../../../helpers/test-state";
import { mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock } from "../../../log-test-spies";
import { APP, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

export const SECRET = "qa-SECRET-value-77x";

export function profileDirs(): () => string {
  let dir = "";
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-profile-rules-test-"));
    process.env.CLAUDE_CONFIG_DIR = join(dir, "default-claude");
    process.env.CODEX_HOME = join(dir, "default-codex");
    await mkdir(join(dir, "default-claude"), { recursive: true });
    await mkdir(join(dir, "default-codex"), { recursive: true });
  });
  afterEach(async () => {
    for (const [key, value] of [
      ["CLAUDE_CONFIG_DIR", saved.claude],
      ["CODEX_HOME", saved.codex],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

function profiles(dir: string): AgentProfile[] {
  return [
    {
      id: "claude-work0001",
      agent: "claude",
      name: "Work",
      color: "violet",
      dir: join(dir, "work"),
      shared: ["CLAUDE.md", "settings.json", "skills", "agents", "commands"],
    },
    {
      id: "claude-gate0001",
      agent: "claude",
      name: "Gateway",
      color: "amber",
      dir: join(dir, "gateway"),
      connection: {
        method: "custom",
        baseUrl: "http://127.0.0.1:9",
        auth: "bearer",
        models: [{ id: "glm" }],
        defaultModel: "glm",
      },
    },
    {
      id: "codex-gate0001",
      agent: "codex",
      name: "Gateway",
      color: "cyan",
      dir: join(dir, "codex-gateway"),
      connection: {
        method: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "glm" }],
        defaultModel: "glm",
      },
    },
    {
      id: "codex-build001",
      agent: "codex",
      name: "Build",
      color: "green",
      dir: join(dir, "build"),
    },
  ];
}

export function profileFixture(dir: string, { windows = false }: { windows?: boolean } = {}) {
  const app = fakeApp();
  const state = openTestState(join(dir, "app-state.json"));
  const seeded: AgentProfiles = { profiles: profiles(dir), rules: [], defaults: {} };
  state.commitState({ agentProfiles: seeded });
  const keys = new ConnectionKeys(keptInMemory(), true);
  const changes: (string | undefined)[] = [];
  app.services = {
    ...app.services,
    profileConnections: createProfileConnections(state, keys, (id) => changes.push(id)),
  };
  const options: RulesOptions = {
    sshConfig: join(dir, "ssh-config"),
    matching: { home: dir, windows: process.platform === "win32" },
  };
  const wrapped = new Map<CliCommand, CliCommand>(
    [chatProfilesRules, chatProfilesRulesSet, chatProfilesRulesRemove].map((command) => [
      command,
      { ...command, run: (ctx, args) => command.run(ctx, args, options) } as CliCommand,
    ]),
  );
  wrapped.set(chatProfilesEdit, {
    ...chatProfilesEdit,
    run: (ctx, args) => chatProfilesEdit.run(ctx, args, { windows }),
  });
  const commands = CLI_COMMANDS.map((command) => wrapped.get(command) ?? command);
  const cli = (argv: string[], stdin?: string) =>
    runCli(
      commands,
      contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }, { cwd: dir, stdin }),
    );
  const config = () => state.getState().agentProfiles as AgentProfiles;
  const profile = (id: string) => config().profiles.find((p) => p.id === id) as AgentProfile;
  return { app, state, cli, config, profile, changes };
}

export function bodyOf(change: ConsentChange | undefined, locale = "ko"): string {
  return change ? (consentDetailsOf(i18next.getFixedT(locale, "settings"), change).body ?? "") : "";
}

export function logged(): string {
  return JSON.stringify(
    [mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock].map((mock) => mock.mock.calls),
  );
}
