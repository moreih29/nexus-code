import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionKeys } from "../../../../src/main/features/agent-profiles/connection-keys";
import { createProfileConnections } from "../../../../src/main/features/agent-profiles/connection-save";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { keptInMemory } from "../../../../src/main/features/remote/sealed-file";
import { StateService } from "../../../../src/main/infra/storage/state-service";
import { connectionKeyTarget } from "../../../../src/shared/agent-profiles/connection";
import { SHARED_BY_DEFAULT } from "../../../../src/shared/agent-profiles/profiles";
import { mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock } from "../../../log-test-spies";
import { APP, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cli-profile-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture() {
  const app = fakeApp();
  const statePath = join(dir, "app-state.json");
  const state = new StateService(statePath);
  const storage = keptInMemory<Record<string, { target: string; key: string }>>();
  const keys = new ConnectionKeys(storage, true);
  const changes: (string | undefined)[] = [];
  app.services = {
    ...app.services,
    profileConnections: createProfileConnections(state, keys, (id) => changes.push(id)),
    readFile: async (_workspace, file) => (await readFile(file)).toString("base64"),
  };
  const run = (args: string[], stdin?: string) =>
    runCli(
      CLI_COMMANDS,
      contextFor(
        app,
        ["chat", "profiles", "add", ...args],
        { workspaceId: APP, tabId: SHELL_TAB },
        { cwd: dir, stdin },
      ),
    );
  return { app, state, statePath, storage, keys, changes, run };
}

const account = ["--agent", "claude", "--name", "Personal", "--dir", "personal"];
const gateway = [
  "--agent",
  "claude",
  "--name",
  "Gateway",
  "--dir",
  "gateway",
  "--preset",
  "litellm",
  "--base-url",
  "https://gateway.example/llm/v1/",
  "--model",
  "glm",
  "--model",
  "kimi",
  "--default-model",
  "kimi",
  "--light-model",
  "glm",
  "--auth",
  "x-api-key",
  "--key-file",
  "-",
];

test("help documents per-model reasoning and its defaults", async () => {
  const { run } = fixture();
  const result = await run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--reasoning MODEL=LEVEL");
  expect(result.stdout).toContain("Claude also auto");
  expect(result.stdout).toContain("Models without the flag stay automatic on Claude");
});

test("adds an account profile and directs the user to sign in from Settings", async () => {
  const { app, state, statePath, storage, run } = fixture();
  app.answers.push("once");
  const result = await run([...account, "--color", "rose"]);
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(saved).toMatchObject({
    agent: "claude",
    name: "Personal",
    dir: join(dir, "personal"),
    color: "rose",
    connection: { method: "account" },
    shared: SHARED_BY_DEFAULT.claude,
  });
  expect(new StateService(statePath).getState().agentProfiles?.profiles).toEqual([saved]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("WORKSPACE DEFAULT");
  expect(result.stdout).toContain(saved?.id as string);
  expect(result.stdout).toContain(join(dir, "personal"));
  expect(result.stdout).toContain("Sign in from Settings › Agents.");
  expect(app.asked).toHaveLength(1);
  expect(app.asked[0]?.change).toMatchObject({
    kind: "profileAdd",
    detail: "Personal",
    profileAdd: { agent: "claude", folder: join(dir, "personal"), connection: "account" },
    eachTime: true,
  });
  expect(app.uiCalls).toEqual([]);
  expect(storage.value).toBeNull();
});

test("saves a custom gateway and its instructions with the stdin key kept separately", async () => {
  const { app, state, keys, statePath, changes, run } = fixture();
  await writeFile(join(dir, "rules.md"), "Use the gateway.\n");
  app.answers.push("once");
  const secret = "a-fixture-key-from-stdin";
  const result = await run(
    [...gateway, "--instructions-file", "rules.md", "--json"],
    `${secret}\r\n`,
  );
  expect(result.exitCode).toBe(0);
  const row = JSON.parse(result.stdout);
  expect(row).toEqual({
    id: expect.stringMatching(/^claude-/),
    name: "Gateway",
    agent: "claude",
    workspaceDefault: false,
    path: join(dir, "gateway"),
  });
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(saved?.connection).toEqual({
    method: "custom",
    preset: "litellm",
    baseUrl: "https://gateway.example/llm",
    auth: "x-api-key",
    models: [{ id: "glm" }, { id: "kimi" }],
    defaultModel: "kimi",
    lightModel: "glm",
  });
  expect(await keys.get(row.id, connectionKeyTarget("claude", saved?.connection))).toBe(secret);
  expect(state.getState().agentInstructions?.profiles).toEqual({ [row.id]: "Use the gateway.\n" });
  expect(changes).toEqual([row.id]);
  expect(app.asked[0]?.change).toEqual({
    kind: "profileAdd",
    detail: "Gateway",
    eachTime: true,
    profileAdd: {
      agent: "claude",
      folder: join(dir, "gateway"),
      connection: "custom",
      endpoint: "https://gateway.example/llm",
    },
  });
  expect(JSON.stringify({ result, asked: app.asked })).not.toContain(secret);
  expect(await readFile(statePath, "utf8")).not.toContain(secret);
});

test("saves every Claude reasoning level while omitted and auto models stay automatic", async () => {
  const { app, state, run } = fixture();
  app.answers.push("once");
  const result = await run([
    ...account,
    "--preset",
    "kimi",
    "--model",
    "plain",
    "--model",
    "model=other",
    "--model",
    "off",
    "--model",
    "high",
    "--model",
    "extra",
    "--model",
    "maximum",
    "--reasoning",
    "model=other=auto",
    "--reasoning",
    "off=none",
    "--reasoning",
    "high=high",
    "--reasoning",
    "extra=xhigh",
    "--reasoning",
    "maximum=max",
  ]);
  expect(result.exitCode).toBe(0);
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toMatchObject({
    models: [
      { id: "plain" },
      { id: "model=other" },
      { id: "off", reasoning: "none" },
      { id: "high", reasoning: "high" },
      { id: "extra", reasoning: "xhigh" },
      { id: "maximum", reasoning: "max" },
    ],
  });
  expect(JSON.stringify(app.asked)).not.toContain("reasoning");
});

test("keeps Codex models without a reasoning flag at none", async () => {
  const { app, state, run } = fixture();
  app.answers.push("once");
  const result = await run([
    "--agent",
    "codex",
    "--name",
    "Gateway",
    "--dir",
    "gateway",
    "--base-url",
    "https://gateway.example/v1",
    "--model",
    "plain",
    "--model",
    "maximum",
    "--reasoning",
    "maximum=max",
  ]);
  expect(result.exitCode).toBe(0);
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toMatchObject({
    models: [{ id: "plain" }, { id: "maximum", reasoning: "max" }],
  });
});

test("accepts a key file for the provider's default API", async () => {
  const { app, state, keys, run } = fixture();
  await writeFile(join(dir, "key.txt"), "fixture-file-key\n");
  app.answers.push("once");
  const result = await run([
    "--agent",
    "codex",
    "--name",
    "API",
    "--dir",
    "api",
    "--method",
    "api-key",
    "--key-file",
    "key.txt",
  ]);
  expect(result.exitCode).toBe(0);
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(saved?.connection).toEqual({ method: "api-key" });
  expect(await keys.get(saved?.id as string, "codex")).toBe("fixture-file-key");
  expect(app.asked[0]?.change.profileAdd).toMatchObject({
    connection: "api-key",
    endpoint: "https://api.openai.com/v1",
  });
});

test("rejects names case-insensitively and folders with equivalent paths", async () => {
  const { app, state, run } = fixture();
  app.answers.push("once");
  expect((await run(account)).exitCode).toBe(0);
  const name = await run(["--agent", "claude", "--name", "personal", "--dir", "other"]);
  const folder = await run([
    "--agent",
    "claude",
    "--name",
    "Other",
    "--dir",
    `${join(dir, "personal")}/`,
  ]);
  expect(name.stderr).toContain("already uses this name");
  expect(folder.stderr).toContain("already uses this folder");
  expect(app.asked).toHaveLength(1);
  expect(state.getState().agentProfiles?.profiles).toHaveLength(1);
});

test("suggests the next available name-based folder and does nothing when approval is denied", async () => {
  const { app, state, storage, run } = fixture();
  state.setState({
    agentProfiles: {
      profiles: [
        {
          id: "claude-existing",
          agent: "claude",
          name: "Existing",
          dir: join(homedir(), ".claude-other-test"),
          color: "green",
        },
      ],
      rules: [],
      defaults: {},
    },
  });
  app.answers.push("deny");
  const result = await run(["--agent", "claude", "--name", "Other Test"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("the user did not allow it");
  expect(app.asked[0]?.change.profileAdd?.folder).toBe("~/.claude-other-test-2");
  expect(state.getState().agentProfiles?.profiles.map(({ id }) => id)).toEqual(["claude-existing"]);
  expect(storage.value).toBeNull();
});

test.each([
  [["--model", "glm", "--model", "glm"], "Model IDs must be unique"],
  [["--model", "glm", "--default-model", "other"], "must be among the listed models"],
  [["--model", "glm", "--light-model", "other"], "must be among the listed models"],
])("rejects incompatible model flags %j before approval", async (flags, message) => {
  const { app, state, run } = fixture();
  const result = await run([...account, "--preset", "kimi", ...flags]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(message);
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test.each([
  [["--reasoning", "other=high"], "--reasoning MODEL must match a --model ID"],
  [["--reasoning", "glm=low"], "--reasoning LEVEL for claude must be none, high, xhigh, max, auto"],
  [["--reasoning", "glm"], "--reasoning takes MODEL=LEVEL"],
  [["--reasoning", "glm=high", "--reasoning", "glm=max"], "--reasoning model IDs must be unique"],
  [
    ["--model", "model;other", "--reasoning", "model;other=high"],
    "Claude reasoning needs a model ID",
  ],
  [
    ["--model", "model,other", "--reasoning", "model,other=high"],
    "Claude reasoning needs a model ID",
  ],
  [
    ["--model", "model=other", "--reasoning", "model=other=high"],
    "Claude reasoning needs a model ID",
  ],
  [["--model", "model*", "--reasoning", "model*=high"], "Claude reasoning needs a model ID"],
])("rejects invalid reasoning flags %j before approval", async (flags, message) => {
  const { app, state, run } = fixture();
  const result = await run([...account, "--preset", "kimi", "--model", "glm", ...flags]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(message);
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test("rejects Codex auto and reasoning flags on account profiles", async () => {
  const { app, state, run } = fixture();
  const codex = await run([
    "--agent",
    "codex",
    "--name",
    "Gateway",
    "--base-url",
    "https://gateway.example/v1",
    "--model",
    "glm",
    "--reasoning",
    "glm=auto",
  ]);
  expect(codex.exitCode).toBe(2);
  expect(codex.stderr).toContain("--reasoning LEVEL for codex must be none, high, xhigh, max");
  const accountResult = await run([...account, "--reasoning", "glm=high"]);
  expect(accountResult.exitCode).toBe(2);
  expect(accountResult.stderr).toContain("require a custom connection");
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test("approval denial leaves the key, profile, and instructions unsaved", async () => {
  const { app, state, storage, run } = fixture();
  const secret = "fixture-denied-key";
  await writeFile(join(dir, "rules.md"), "Read this next time.\n");
  app.answers.push("deny");
  const result = await run([...gateway, "--instructions-file", "rules.md"], secret);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("the user did not allow it");
  expect(JSON.stringify({ result, asked: app.asked })).not.toContain(secret);
  expect(state.getState().agentProfiles).toBeUndefined();
  expect(state.getState().agentInstructions).toBeUndefined();
  expect(storage.value).toBeNull();
});

test("malformed keys and storage errors never echo or log key material", async () => {
  const { app, state, storage, run } = fixture();
  const logs = [mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock];
  const offsets = logs.map((log) => log.mock.calls.length);
  const secret = "fixture-sensitive-key";
  const invalid = await run(gateway, `${secret}\nextra line`);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("Invalid API key");
  expect(app.asked).toEqual([]);
  app.answers.push("once");
  storage.save = async () => {
    throw new Error(`storage failed for ${secret}`);
  };
  const failed = await run(gateway, secret);
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain("Could not save the agent profile");
  const logged = logs.flatMap((log, i) => log.mock.calls.slice(offsets[i]));
  expect(JSON.stringify({ invalid, failed, asked: app.asked, logged })).not.toContain(secret);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test("rechecks collisions when two approvals race, keeping only the saved profile's key", async () => {
  const { app, state, storage, run } = fixture();
  app.answers.push("once", "once");
  const results = await Promise.all([
    run(gateway, "fixture-first"),
    run(gateway, "fixture-second"),
  ]);
  expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 2]);
  expect(results.find(({ exitCode }) => exitCode === 2)?.stderr).toContain(
    "already uses this name",
  );
  expect(app.asked).toHaveLength(2);
  const profiles = state.getState().agentProfiles?.profiles ?? [];
  expect(profiles).toHaveLength(1);
  expect(Object.keys(storage.value ?? {})).toEqual(profiles.map(({ id }) => id));
});
