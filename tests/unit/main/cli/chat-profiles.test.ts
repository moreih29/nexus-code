import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionKeys } from "../../../../src/main/features/agent-profiles/connection-keys";
import { createProfileConnections } from "../../../../src/main/features/agent-profiles/connection-save";
import { redactedBaseUrl } from "../../../../src/main/features/agent-profiles/connection-view";
import { expandHome } from "../../../../src/main/features/agent-profiles/local";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { chatProfilesAdd } from "../../../../src/main/features/cli/commands/chat-profiles";
import { type CliCommand, runCli } from "../../../../src/main/features/cli/registry";
import { keptInMemory } from "../../../../src/main/features/remote/sealed-file";
import { connectionKeyTarget } from "../../../../src/shared/agent-profiles/connection";
import { SHARED_BY_DEFAULT } from "../../../../src/shared/agent-profiles/profiles";
import { openTestState } from "../../../helpers/test-state";
import { mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock } from "../../../log-test-spies";
import { APP, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cli-profile-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture({ windows }: { windows?: boolean } = {}) {
  const app = fakeApp();
  const statePath = join(dir, "app-state.json");
  const state = openTestState(statePath);
  const storage = keptInMemory<Record<string, { target: string; key: string }>>();
  const keys = new ConnectionKeys(storage, true);
  const changes: (string | undefined)[] = [];
  app.services = {
    ...app.services,
    profileConnections: createProfileConnections(state, keys, (id) => changes.push(id)),
    readFile: async (_workspace, file) => (await readFile(file)).toString("base64"),
  };
  const commands: readonly CliCommand[] =
    windows === undefined
      ? CLI_COMMANDS
      : [{ ...chatProfilesAdd, run: (ctx, args) => chatProfilesAdd.run(ctx, args, { windows }) }];
  const cli = (argv: string[], stdin?: string) =>
    runCli(
      commands,
      contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }, { cwd: dir, stdin }),
    );
  const run = (args: string[], stdin?: string) => cli(["chat", "profiles", "add", ...args], stdin);
  const listed = () => {
    const config = state.getState().agentProfiles;
    app.uiAnswers.set("chat.profiles", {
      profiles: (config?.profiles ?? []).map(({ id, name, agent, dir: path }) => ({
        id,
        name,
        agent,
        isDefault: false,
        workspaceDefault: false,
        path,
      })),
    });
  };
  return { app, state, statePath, storage, keys, changes, run, cli, listed };
}

const accountProfile = ["--agent", "claude", "--name", "Personal"];
const account = [...accountProfile, "--dir", "personal"];
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
    color: "rose",
    connection: { method: "account" },
    shared: SHARED_BY_DEFAULT.claude,
  });
  expect(expandHome(saved?.dir ?? "")).toBe(join(dir, "personal"));
  expect(openTestState(statePath).getState().agentProfiles?.profiles).toEqual([saved]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("WORKSPACE DEFAULT");
  expect(result.stdout).toContain(saved?.id as string);
  expect(result.stdout).toContain(saved?.dir as string);
  expect(result.stdout).toContain("Sign in from Settings › Agents.");
  expect(app.asked).toHaveLength(1);
  expect(app.asked[0]?.change).toMatchObject({
    kind: "profileAdd",
    detail: "Personal",
    profileAdd: { agent: "claude", folder: saved?.dir, connection: "account" },
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
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(row).toEqual({
    id: expect.stringMatching(/^claude-/),
    name: "Gateway",
    agent: "claude",
    workspaceDefault: false,
    path: saved?.dir,
  });
  expect(expandHome(saved?.dir ?? "")).toBe(join(dir, "gateway"));
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
      folder: saved?.dir,
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

test.each([
  'C:\\some folder"',
  "C:\\some<folder",
  "C:\\some>folder",
  "C:\\some|folder",
  "C:\\some?folder",
  "C:\\some*folder",
  "C:\\some:folder",
  "some:folder",
])("rejects Windows folder %j before approval", async (folder) => {
  const { app, state, run } = fixture({ windows: true });
  const result = await run([...accountProfile, "--dir", folder]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Windows --dir cannot contain");
  expect(result.stderr).toContain("In PowerShell, omit a trailing backslash inside a quoted path.");
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test.each([
  "C:\\profiles\\work",
  "C:\\profiles\\프로필 폴더",
  "~/nexus-cli-test-profile",
])("requests approval for valid Windows folder %j", async (folder) => {
  const { app, run } = fixture({ windows: true });
  app.answers.push("deny");
  const result = await run([...accountProfile, "--dir", folder]);
  expect(result.stderr).toContain("the user did not allow it");
  expect(app.asked).toHaveLength(1);
  if (folder.startsWith("~/")) expect(app.asked[0]?.change.profileAdd?.folder).toBe(folder);
});

test("requests approval for a folder with a quote on non-Windows", async () => {
  const { app, run } = fixture({ windows: false });
  app.answers.push("deny");
  const result = await run([...accountProfile, "--dir", 'some folder"']);
  expect(result.stderr).toContain("the user did not allow it");
  expect(app.asked[0]?.change.profileAdd?.folder).toContain('some folder"');
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

const SECRET = "sk-qa-SECRETVALUE-zz9q";

function logged(): string {
  return JSON.stringify(
    [mainDebugMock, mainErrorMock, mainInfoMock, mainWarnMock].map((mock) => mock.mock.calls),
  );
}

test("chat profiles shows each profile's connection and only whether a key is saved", async () => {
  const { app, cli, run, listed, state } = fixture();
  app.answers.push("once");
  expect((await run(gateway, `${SECRET}\n`)).exitCode).toBe(0);
  listed();
  const id = state.getState().agentProfiles?.profiles[0]?.id;
  const json = await cli(["chat", "profiles", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout).profiles).toEqual([
    {
      id,
      name: "Gateway",
      agent: "claude",
      workspaceDefault: false,
      color: "violet",
      connection: {
        method: "custom",
        preset: "litellm",
        baseUrl: "https://gateway.example/llm",
        auth: "x-api-key",
        models: [{ id: "glm" }, { id: "kimi" }],
        defaultModel: "kimi",
        lightModel: "glm",
      },
      hasKey: true,
    },
  ]);
  const text = await cli(["chat", "profiles", "--profile", "gateway"]);
  expect(text.stdout).toContain(
    `Gateway (${id}) · custom · https://gateway.example/llm · x-api-key · preset litellm · key saved`,
  );
  expect(text.stdout).toContain("  Model glm · light\n  Model kimi · default");
  const missing = await cli(["chat", "profiles", "--profile", "nope"]);
  expect(missing.stderr).toContain('no profile "nope"');
  for (const shown of [json, text, missing]) {
    expect(JSON.stringify(shown)).not.toContain("SECRETVALUE");
    expect(JSON.stringify(shown)).not.toContain("zz9q");
  }
  expect(logged()).not.toContain("SECRETVALUE");
});

const SECRET_URL = "https://qa:pa55word@gateway.example/llm?key=SECRETVALUE&team=a&team=b#tok-zz9q";

function withBaseUrl(state: ReturnType<typeof openTestState>, baseUrl: string) {
  const config = state.getState().agentProfiles;
  if (!config) throw new Error("no profiles");
  state.commitState({
    agentProfiles: {
      ...config,
      profiles: config.profiles.map((profile) =>
        profile.connection?.method === "custom"
          ? { ...profile, connection: { ...profile.connection, baseUrl } }
          : profile,
      ),
    },
  });
}

test("chat profiles hides the user, password, query values and fragment of a base URL", async () => {
  const { app, cli, run, listed, state } = fixture();
  app.answers.push("once");
  expect((await run(gateway, "sk-qa-key\n")).exitCode).toBe(0);
  withBaseUrl(state, SECRET_URL);
  listed();
  const json = await cli(["chat", "profiles", "--json"]);
  expect(JSON.parse(json.stdout).profiles[0].connection).toMatchObject({
    baseUrl: "https://gateway.example/llm?key=***&team=***",
    baseUrlRedacted: true,
  });
  const text = await cli(["chat", "profiles", "--profile", "Gateway"]);
  expect(text.stdout).toContain("https://gateway.example/llm?key=***&team=*** (secrets hidden)");
  for (const shown of [json, text]) {
    for (const part of ["pa55word", "qa:", "SECRETVALUE", "team=a", "zz9q"]) {
      expect(JSON.stringify(shown)).not.toContain(part);
    }
  }
  withBaseUrl(state, "gateway without scheme");
  const unreadable = await cli(["chat", "profiles", "--json"]);
  const connection = JSON.parse(unreadable.stdout).profiles[0].connection;
  expect(connection.baseUrl).toBeUndefined();
  expect(connection.baseUrlRedacted).toBe(true);
  expect((await cli(["chat", "profiles"])).stdout).toContain("custom · address hidden");
});

test("redactedBaseUrl keeps a plain address as given", () => {
  expect(redactedBaseUrl("https://gateway.example/llm")).toEqual({
    baseUrl: "https://gateway.example/llm",
    redacted: false,
  });
  expect(redactedBaseUrl("http://127.0.0.1:9/v1?")).toEqual({
    baseUrl: "http://127.0.0.1:9/v1?",
    redacted: false,
  });
  expect(redactedBaseUrl("https://user@host.example")).toEqual({
    baseUrl: "https://host.example/",
    redacted: true,
  });
});

test("profiles add saves context windows the way each agent reads them, and labels", async () => {
  const { app, state, run } = fixture();
  app.answers.push("once", "once");
  const claude = await run([
    ...account,
    "--base-url",
    "http://127.0.0.1:9",
    "--model",
    "k3.1-pro",
    "--model",
    "glm-5.4",
    "--context-window",
    "400000",
    "--label",
    "glm-5.4=GLM = 5.4",
  ]);
  expect(claude.stderr).toBe("");
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toMatchObject({
    models: [{ id: "k3.1-pro" }, { id: "glm-5.4", label: "GLM = 5.4" }],
    contextWindow: 400000,
  });
  const codex = await run([
    "--agent",
    "codex",
    "--name",
    "Codex gateway",
    "--dir",
    "codex-gateway",
    "--base-url",
    "http://127.0.0.1:9/v1",
    "--model",
    "k3.1-pro",
    "--model",
    "glm-5.4",
    "--context-window",
    "k3.1-pro=400000",
    "--context-window",
    "glm-5.4=400000",
  ]);
  expect(codex.stderr).toBe("");
  const saved = state.getState().agentProfiles?.profiles[1]?.connection;
  expect(saved).toMatchObject({
    models: [
      { id: "k3.1-pro", contextWindow: 400000 },
      { id: "glm-5.4", contextWindow: 400000 },
    ],
  });
  expect(saved && "contextWindow" in saved).toBe(false);
});

test.each([
  [["--context-window", "0"], "from 1 to 2147483647, or auto"],
  [["--context-window", "-5"], "from 1 to 2147483647, or auto"],
  [["--context-window", "2147483648"], "from 1 to 2147483647, or auto"],
  [["--context-window", "1e6"], "from 1 to 2147483647, or auto"],
  [["--context-window", "400000", "--context-window", "500000"], "once"],
  [["--context-window", "glm=400000"], "Claude uses one context window for every model"],
  [["--label", "other=Other"], "--label MODEL must match a --model ID"],
  [["--label", "glm"], "--label takes MODEL=TEXT"],
  [["--label", `glm=${"x".repeat(129)}`], "at most 128 characters"],
])("rejects invalid Claude context and label flags %j before approval", async (flags, message) => {
  const { app, state, run } = fixture();
  const result = await run([...account, "--preset", "kimi", "--model", "glm", ...flags]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(message);
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test.each([
  [["--context-window", "400000"], "Codex sets a context window for each model"],
  [["--context-window", "other=400000"], "--context-window MODEL must match a --model ID"],
  [["--context-window", "glm=0"], "from 1 to 2147483647, or auto"],
  [["--context-window", "glm=1", "--context-window", "glm=2"], "model IDs must be unique"],
])("rejects invalid Codex context flags %j before approval", async (flags, message) => {
  const { app, state, run } = fixture();
  const result = await run([
    "--agent",
    "codex",
    "--name",
    "Gateway",
    "--base-url",
    "https://gateway.example/v1",
    "--model",
    "glm",
    ...flags,
  ]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(message);
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

const claudeGateway = [
  "--agent",
  "claude",
  "--name",
  "Gateway",
  "--dir",
  "gateway",
  "--base-url",
  "http://127.0.0.1:9",
  "--auth",
  "x-api-key",
  "--model",
  "k3.1-pro",
  "--model",
  "glm-5.3",
  "--reasoning",
  "glm-5.3=high",
  "--default-model",
  "glm-5.3",
  "--light-model",
  "k3.1-pro",
  "--context-window",
  "400000",
  "--key-file",
  "-",
];

async function withGateway() {
  const setup = fixture();
  setup.app.answers.push("once");
  const added = await setup.run(claudeGateway, `${SECRET}\n`);
  expect(added.exitCode).toBe(0);
  const id = setup.state.getState().agentProfiles?.profiles[0]?.id as string;
  const edit = (args: string[], stdin?: string) =>
    setup.cli(["chat", "profiles", "edit", ...args], stdin);
  return { ...setup, id, edit };
}

test("profiles edit renames a model with its settings, moves the default and replaces the key", async () => {
  const { app, state, keys, statePath, changes, id, edit } = await withGateway();
  app.answers.push("once");
  const fresh = "sk-qa-NEWSECRET-k7";
  const result = await edit(
    ["Gateway", "--rename-model", "glm-5.3=glm-5.4", "--key-file", "-", "--json"],
    `${fresh}\n`,
  );
  expect(result.stderr).toBe("");
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(saved?.connection).toEqual({
    method: "custom",
    baseUrl: "http://127.0.0.1:9",
    auth: "x-api-key",
    models: [{ id: "k3.1-pro" }, { id: "glm-5.4", reasoning: "high" }],
    defaultModel: "glm-5.4",
    lightModel: "k3.1-pro",
    contextWindow: 400000,
  });
  expect(await keys.get(id, connectionKeyTarget("claude", saved?.connection))).toBe(fresh);
  expect(app.asked[1]?.change).toEqual({
    kind: "profileEdit",
    detail: "Gateway",
    eachTime: true,
    profileEdit: {
      agent: "claude",
      lines: [
        { field: "models", value: "k3.1-pro, glm-5.3 → k3.1-pro, glm-5.4" },
        { field: "defaultModel", value: "glm-5.3 → glm-5.4" },
        { field: "key", change: "replaced" },
      ],
    },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    id,
    name: "Gateway",
    hasKey: true,
    changed: ["models", "defaultModel", "key"],
    connection: { defaultModel: "glm-5.4", contextWindow: 400000 },
  });
  expect(changes.at(-1)).toBe(id);
  const shown = JSON.stringify({ result, asked: app.asked });
  for (const secret of ["SECRETVALUE", "zz9q", "NEWSECRET", 'k7"']) {
    expect(shown).not.toContain(secret);
  }
  expect(await readFile(statePath, "utf8")).not.toContain("NEWSECRET");
  expect(logged()).not.toContain("NEWSECRET");
});

test("profiles edit adds, removes and tunes models and clears what auto names", async () => {
  const { app, state, edit } = await withGateway();
  app.answers.push("once");
  const result = await edit([
    "gateway",
    "--add-model",
    "glm-5.4",
    "--remove-model",
    "k3.1-pro",
    "--default-model",
    "glm-5.4",
    "--light-model",
    "auto",
    "--reasoning",
    "glm-5.3=auto",
    "--label",
    "glm-5.4=GLM 5.4",
    "--context-window",
    "auto",
  ]);
  expect(result.stderr).toBe("");
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toEqual({
    method: "custom",
    baseUrl: "http://127.0.0.1:9",
    auth: "x-api-key",
    models: [{ id: "glm-5.3" }, { id: "glm-5.4", label: "GLM 5.4" }],
    defaultModel: "glm-5.4",
  });
  expect(app.asked[1]?.change.profileEdit?.lines).toEqual([
    { field: "models", value: "k3.1-pro, glm-5.3 → glm-5.3, glm-5.4" },
    { field: "defaultModel", value: "glm-5.3 → glm-5.4" },
    { field: "lightModel", value: "k3.1-pro → auto" },
    { field: "context", value: "400000 → auto" },
    { field: "reasoning", value: "glm-5.3 high → auto" },
    { field: "label", value: 'glm-5.4 "" → "GLM 5.4"' },
  ]);
});

test("profiles edit keeps a key with its old address and says to give it again", async () => {
  const { app, keys, state, id, edit } = await withGateway();
  app.answers.push("once");
  const result = await edit(["Gateway", "--base-url", "http://127.0.0.1:10", "--json"]);
  expect(result.stderr).toBe("");
  const row = JSON.parse(result.stdout);
  expect(row.hasKey).toBe(false);
  expect(row.note).toContain("give it again with --key-file");
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(await keys.get(id, connectionKeyTarget("claude", saved?.connection))).toBeUndefined();
  expect(app.asked[1]?.change.profileEdit?.lines).toEqual([
    { field: "address", value: "http://127.0.0.1:9 → http://127.0.0.1:10" },
  ]);
});

test.each([
  [["--default-model", "nope"], "--default-model must be one of the profile's models"],
  [["--light-model", "nope"], "--light-model must be one of the profile's models"],
  [["--remove-model", "k3.1-pro", "--remove-model", "glm-5.3"], "at least one model"],
  [["--remove-model", "glm-5.3"], 'The default model "glm-5.3" is no longer listed'],
  [["--remove-model", "nope"], "is not a model of the profile"],
  [["--add-model", "glm-5.3"], "is already a model of the profile"],
  [["--rename-model", "nope=x"], "OLD one of the profile's models"],
  [["--rename-model", "glm-5.3=k3.1-pro"], "is already a model of the profile"],
  [["--model", "a", "--add-model", "b"], "Give --model to replace the list"],
  [["--context-window", "0"], "from 1 to 2147483647, or auto"],
  [["--context-window", "-400000"], "from 1 to 2147483647, or auto"],
  [["--context-window", "glm-5.3=400000"], "Claude uses one context window"],
  [["--reasoning", "nope=high"], "--reasoning MODEL must match a model of the profile"],
  [["--auth", "basic"], "--auth must be bearer or x-api-key"],
  [["--preset", "nope"], "--preset for claude must be one of"],
  [["--name", ""], "Give a --name of 1 to 40 characters"],
  [["--color", "pink"], "--color must be one of"],
  [["--key-file", "-", "--remove-key"], "not both"],
  [["--method", "account", "--key-file", "-"], "--key-file requires an API connection"],
  [["--method", "api-key"], "--method api-key requires --key-file"],
  [["--method", "account", "--add-model", "x"], "give the models with --model"],
  [[], "Nothing to change"],
  [["--color", "violet"], "Nothing to change"],
])("profiles edit rejects %j before approval", async (flags, message) => {
  const { app, state, keys, id, edit } = await withGateway();
  const before = JSON.stringify(state.getState().agentProfiles);
  const result = await edit(["Gateway", ...flags], "sk-qa-unused-1\n");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(message);
  expect(app.asked).toHaveLength(1);
  expect(JSON.stringify(state.getState().agentProfiles)).toBe(before);
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(await keys.get(id, connectionKeyTarget("claude", saved?.connection))).toBe(SECRET);
});

test("profiles edit refuses a name another profile of the agent uses, and edits the default profile", async () => {
  const { app, state, edit } = await withGateway();
  const taken = await edit(["Gateway", "--name", "DEFAULT"]);
  expect(taken.exitCode).toBe(2);
  expect(taken.stderr).toContain("A profile already uses this name for this agent");
  app.answers.push("once");
  const renamed = await edit([
    "default",
    "--agent",
    "claude",
    "--name",
    "Main",
    "--color",
    "green",
  ]);
  expect(renamed.stderr).toBe("");
  expect(app.asked.at(-1)?.change).toMatchObject({
    kind: "profileEdit",
    detail: "default",
    profileEdit: {
      lines: [
        { field: "name", value: "default → Main" },
        { field: "color", value: "blue → green" },
      ],
    },
  });
  expect(
    state.getState().agentProfiles?.profiles.find(({ id }) => id === "claude-default"),
  ).toMatchObject({
    name: "Main",
    color: "green",
  });
  const account = await edit(["Main", "--base-url", "http://127.0.0.1:9"]);
  expect(account.stderr).toContain("require a custom connection");
});

test("profiles edit saves nothing when the user denies it or the profile changes meanwhile", async () => {
  const { app, state, keys, id, edit } = await withGateway();
  const before = JSON.stringify(state.getState().agentProfiles);
  app.answers.push("deny");
  const denied = await edit(["Gateway", "--remove-key"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("the user did not allow it");
  expect(JSON.stringify(state.getState().agentProfiles)).toBe(before);
  const target = connectionKeyTarget(
    "claude",
    state.getState().agentProfiles?.profiles[0]?.connection,
  );
  expect(await keys.get(id, target)).toBe(SECRET);
  const ask = app.services.askUser;
  app.services = {
    ...app.services,
    askUser: async (request, signal) => {
      const config = state.getState().agentProfiles;
      if (config) {
        state.commitState({
          agentProfiles: {
            ...config,
            profiles: config.profiles.map((p) => ({ ...p, color: "amber" })),
          },
        });
      }
      await ask(request, signal);
    },
  };
  app.answers.push("once");
  const raced = await edit(["Gateway", "--name", "Renamed"]);
  expect(raced.stderr).toContain("The profile changed while waiting for approval");
  expect(state.getState().agentProfiles?.profiles[0]?.name).toBe("Gateway");
  expect(await keys.get(id, target)).toBe(SECRET);
});

test("profiles edit switches a Codex profile's per-model context windows", async () => {
  const { app, state, run, cli } = fixture();
  app.answers.push("once", "once");
  await run([
    "--agent",
    "codex",
    "--name",
    "Codex",
    "--dir",
    "codex",
    "--base-url",
    "http://127.0.0.1:9/v1",
    "--model",
    "glm-5.4",
    "--context-window",
    "glm-5.4=131072",
  ]);
  const result = await cli([
    "chat",
    "profiles",
    "edit",
    "Codex",
    "--context-window",
    "glm-5.4=400000",
  ]);
  expect(result.stderr).toBe("");
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toMatchObject({
    models: [{ id: "glm-5.4", contextWindow: 400000 }],
  });
  expect(app.asked[1]?.change.profileEdit?.lines).toEqual([
    { field: "context", value: "glm-5.4 131072 → 400000" },
  ]);
  const shared = await cli(["chat", "profiles", "edit", "Codex", "--context-window", "400000"]);
  expect(shared.stderr).toContain("Codex sets a context window for each model");
});

test("profiles remove deletes a profile after approval and leaves its folder", async () => {
  const { app, state, changes, id, cli } = await withGateway();
  const config = state.getState().agentProfiles;
  if (!config) throw new Error("no profiles");
  state.commitState({
    agentProfiles: { ...config, defaults: { claude: id } },
  });
  const dir = config.profiles[0]?.dir;
  app.answers.push("once");
  const result = await cli(["chat", "profiles", "remove", "gateway", "--json"]);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    id,
    name: "Gateway",
    agent: "claude",
    path: dir,
    removed: true,
  });
  expect(app.asked[1]?.change).toEqual({
    kind: "profileRemove",
    detail: "Gateway",
    eachTime: true,
    profileRemove: { agent: "claude", folder: dir },
  });
  expect(state.getState().agentProfiles).toEqual({ profiles: [], rules: [], defaults: {} });
  expect(changes.at(-1)).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
});

test("profiles remove refuses the default profile and saves nothing on denial", async () => {
  const { app, state, cli } = await withGateway();
  const before = JSON.stringify(state.getState().agentProfiles);
  const fallback = await cli(["chat", "profiles", "remove", "default", "--agent", "claude"]);
  expect(fallback.exitCode).toBe(2);
  expect(fallback.stderr).toContain("The default profile cannot be removed");
  const missing = await cli(["chat", "profiles", "remove", "nope"]);
  expect(missing.stderr).toContain('no profile "nope" on this computer');
  app.answers.push("deny");
  const denied = await cli(["chat", "profiles", "remove", "Gateway"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("the user did not allow it");
  expect(app.asked).toHaveLength(2);
  expect(JSON.stringify(state.getState().agentProfiles)).toBe(before);
});

test("profiles add --from copies a local profile's connection but never its key", async () => {
  const { app, state, keys, run, id } = await withGateway();
  app.answers.push("once");
  const result = await run([
    "--from",
    "Gateway",
    "--name",
    "Gateway copy",
    "--dir",
    "copy",
    "--json",
  ]);
  expect(result.stderr).toBe("");
  const [original, copy] = state.getState().agentProfiles?.profiles ?? [];
  expect(copy?.connection).toEqual(original?.connection);
  expect(copy).toMatchObject({ agent: "claude", name: "Gateway copy", color: original?.color });
  expect(
    await keys.get(copy?.id as string, connectionKeyTarget("claude", copy?.connection)),
  ).toBeUndefined();
  const json = JSON.parse(result.stdout);
  expect(json.from).toEqual({ id, name: "Gateway" });
  expect(json.notes).toEqual([
    `The profile has an API key. Keys stay on each computer: give this one with nexus chat profiles edit ${copy?.id} --key-file -`,
  ]);
  expect(app.asked[1]?.change).toMatchObject({
    kind: "profileAdd",
    detail: "Gateway copy",
    profileAdd: { agent: "claude", connection: "custom", endpoint: "http://127.0.0.1:9" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
  const same = await run(["--from", "Gateway", "--dir", "again"]);
  expect(same.stderr).toContain("A profile already uses this name for this agent");
});

const ihWin = { id: "55555555-5555-4555-8555-555555555555", name: "ihWin" };
const peerGateway = {
  id: "claude-remote",
  name: "Gateway",
  agent: "claude",
  isDefault: false,
  color: "cyan",
  hasKey: true,
  connection: {
    method: "custom",
    baseUrl: "http://127.0.0.1:9",
    auth: "x-api-key",
    models: [
      { id: "k3.1-pro", reasoning: "high" },
      { id: "glm-5.4", label: "GLM" },
    ],
    defaultModel: "glm-5.4",
    lightModel: "k3.1-pro",
    contextWindow: 400000,
    advanced: { timeoutMs: 600000, headers: ["X-Org"] },
  },
};

function withPeer(
  app: ReturnType<typeof fixture>["app"],
  serves: string[],
  row: unknown = peerGateway,
) {
  app.peers.devices = [
    { ...ihWin, platform: "win32", online: true, self: false, schema: "0.38.0", serves },
  ];
  app.peers.answer = async () => ({ profiles: [row] });
}

test("profiles add --from takes a new address for a local copy from --base-url", async () => {
  const { app, state, run } = await withGateway();
  app.answers.push("once");
  const result = await run(
    [
      "--from",
      "Gateway",
      "--name",
      "Gateway two",
      "--dir",
      "two",
      "--base-url",
      "http://127.0.0.1:10",
      "--key-file",
      "-",
    ],
    "sk-qa-key\n",
  );
  expect(result.stderr).toBe("");
  const copy = state.getState().agentProfiles?.profiles.find(({ name }) => name === "Gateway two");
  expect(copy?.connection).toMatchObject({ method: "custom", baseUrl: "http://127.0.0.1:10" });
});

test("profiles add --from-device copies another computer's connection with this computer's key", async () => {
  const { app, state, keys, run } = fixture();
  withPeer(app, ["agents", "agents.cli", "profiles.connection"]);
  app.answers.push("once");
  const local = "sk-qa-LOCALKEY-55";
  const result = await run(
    [
      "--from",
      "Gateway",
      "--from-device",
      "ihWin",
      "--dir",
      "gateway",
      "--key-file",
      "-",
      "--json",
    ],
    `${local}\n`,
  );
  expect(result.stderr).toBe("");
  const saved = state.getState().agentProfiles?.profiles[0];
  expect(saved).toMatchObject({ agent: "claude", name: "Gateway", color: "cyan" });
  expect(saved?.connection).toEqual({
    method: "custom",
    baseUrl: "http://127.0.0.1:9",
    auth: "x-api-key",
    models: [
      { id: "k3.1-pro", reasoning: "high" },
      { id: "glm-5.4", label: "GLM" },
    ],
    defaultModel: "glm-5.4",
    lightModel: "k3.1-pro",
    contextWindow: 400000,
    advanced: { timeoutMs: 600000 },
  });
  expect(
    await keys.get(saved?.id as string, connectionKeyTarget("claude", saved?.connection)),
  ).toBe(local);
  expect(app.peers.requests).toEqual([
    {
      deviceId: ihWin.id,
      method: "profiles.list",
      params: {
        connection: true,
        profile: "Gateway",
        from: { kind: "terminal", workspaceId: APP, tabId: SHELL_TAB },
      },
      timeoutMs: undefined,
    },
  ]);
  const json = JSON.parse(result.stdout);
  expect(json.from).toEqual({ id: "claude-remote", name: "Gateway", device: ihWin });
  expect(json.notes).toEqual([
    'Header and query values stay on "ihWin": add X-Org in Settings › Agents.',
  ]);
  expect(JSON.stringify({ result, requests: app.peers.requests })).not.toContain("LOCALKEY");
});

test("profiles add --from-device refuses an older computer, extra connection flags and unreadable settings", async () => {
  const { app, state, run } = fixture();
  withPeer(app, ["agents", "agents.cli"]);
  const older = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(older.exitCode).toBe(3);
  expect(older.stderr).toContain('Update NexusCode on "ihWin" to copy its profiles');
  expect(app.peers.requests).toEqual([]);
  withPeer(app, ["agents", "agents.cli", "profiles.connection"]);
  const flags = await run(["--from", "Gateway", "--from-device", "ihWin", "--model", "x"]);
  expect(flags.stderr).toContain("--from copies the connection, so leave out --model");
  const lone = await run(["--from-device", "ihWin", "--agent", "claude", "--name", "X"]);
  expect(lone.stderr).toContain("--from-device needs --from PROFILE");
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: { ...peerGateway.connection, defaultModel: "missing" },
  });
  const unreadable = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(unreadable.stderr).toContain("must be among the listed models");
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: { method: "api-key" },
  });
  const apiKey = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(apiKey.stderr).toContain("--from names an API key profile: give its key with --key-file");
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: { ...peerGateway.connection, models: [{ id: "glm-5.4", reasoning: "future" }] },
  });
  const future = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(future.stderr).toContain('Could not read the connection of "Gateway" on "ihWin"');
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
});

test("profiles add --from-device refuses a hidden address and takes one from --base-url", async () => {
  const { app, state, run } = fixture();
  const hidden =
    'on "ihWin" has an address with a user, password or query values that are not shared; give the address with --base-url';
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: {
      ...peerGateway.connection,
      baseUrl: "http://127.0.0.1:9/?key=***",
      baseUrlRedacted: true,
    },
  });
  const redacted = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(redacted.exitCode).toBe(2);
  expect(redacted.stderr).toContain(`"Gateway" ${hidden}`);
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: { ...peerGateway.connection, baseUrl: "http://qa:pa55word@127.0.0.1:9" },
  });
  const faulty = await run(["--from", "Gateway", "--from-device", "ihWin"]);
  expect(faulty.stderr).toContain(hidden);
  expect(faulty.stderr).not.toContain("pa55word");
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    connection: { ...peerGateway.connection, baseUrl: undefined, baseUrlRedacted: true },
  });
  expect((await run(["--from", "Gateway", "--from-device", "ihWin"])).stderr).toContain(hidden);
  const empty = await run(["--from", "Gateway", "--from-device", "ihWin", "--base-url", " "]);
  expect(empty.stderr).toContain("Give --base-url an address");
  expect(app.asked).toEqual([]);
  expect(state.getState().agentProfiles).toBeUndefined();
  app.answers.push("once");
  const given = await run(
    [
      "--from",
      "Gateway",
      "--from-device",
      "ihWin",
      "--base-url",
      "http://127.0.0.1:10/v1",
      "--dir",
      "gateway",
      "--key-file",
      "-",
    ],
    "sk-qa-key\n",
  );
  expect(given.stderr).toBe("");
  expect(state.getState().agentProfiles?.profiles[0]?.connection).toMatchObject({
    method: "custom",
    baseUrl: "http://127.0.0.1:10",
    defaultModel: "glm-5.4",
  });
  withPeer(app, ["agents", "agents.cli", "profiles.connection"], {
    ...peerGateway,
    name: "Main",
    connection: { method: "account" },
  });
  const account = await run([
    "--from",
    "Main",
    "--from-device",
    "ihWin",
    "--base-url",
    "http://127.0.0.1:9",
  ]);
  expect(account.stderr).toContain("--base-url with --from needs a custom connection to copy");
});

test("nexus help and each command's help name the profile commands and their key rules", async () => {
  const { cli } = fixture();
  const help = await cli(["help"]);
  for (const path of ["chat profiles add", "chat profiles edit", "chat profiles remove"]) {
    expect(help.stdout).toContain(path);
  }
  const edit = await cli(["chat", "profiles", "edit", "--help"]);
  expect(edit.stdout).toContain("--rename-model OLD=NEW");
  expect(edit.stdout).toContain("--key-file FILE");
  expect(edit.stdout).toContain("--remove-key");
  const add = await cli(["chat", "profiles", "add", "--help"]);
  expect(add.stdout).toContain("--from-device NAME");
  expect(add.stdout).toContain("Keys never move between");
  const list = await cli(["chat", "profiles", "--help"]);
  expect(list.stdout).toContain("API keys are never shown");
});
