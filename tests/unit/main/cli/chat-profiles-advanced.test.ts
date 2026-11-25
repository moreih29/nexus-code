import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyOf, logged, profileDirs, profileFixture, SECRET } from "./profile-test-fixture";

const dirOf = profileDirs();
const fixture = () => profileFixture(dirOf());

test("edit sets environment variables, headers and query values from files without showing values", async () => {
  const { app, cli, profile } = fixture();
  const offsets = logged().length;
  await writeFile(join(dirOf(), "headers.txt"), `X-Org: ${SECRET}\nX-Trace: on\n`);
  app.answers.push("once");
  const env = await cli(
    [
      "chat",
      "profiles",
      "edit",
      "Gateway",
      "--agent",
      "claude",
      "--env-file",
      "-",
      "--header-file",
      "headers.txt",
      "--json",
    ],
    `# proxy\nHTTPS_PROXY=http://127.0.0.1:9\nTOKEN=${SECRET}\n`,
  );
  expect(env.exitCode).toBe(0);
  const gateway = profile("claude-gate0001");
  expect(gateway.env).toEqual({ HTTPS_PROXY: "http://127.0.0.1:9", TOKEN: SECRET });
  expect(gateway.connection?.method === "custom" && gateway.connection.advanced?.headers).toEqual({
    "X-Org": SECRET,
    "X-Trace": "on",
  });
  const json = JSON.parse(env.stdout);
  expect(json.env).toEqual(["HTTPS_PROXY", "TOKEN"]);
  expect(json.connection.advanced.headers).toEqual(["X-Org", "X-Trace"]);
  expect(json.changed).toEqual(["env", "header"]);
  const change = app.asked[0]?.change;
  expect(change?.profileEdit?.lines).toEqual([
    { field: "env", name: "HTTPS_PROXY", change: "added" },
    { field: "env", name: "TOKEN", change: "added" },
    { field: "header", name: "X-Org", change: "added" },
    { field: "header", name: "X-Trace", change: "added" },
  ]);
  expect(bodyOf(change)).toContain("환경 변수 TOKEN 추가");

  app.answers.push("once");
  const codex = await cli(
    [
      "chat",
      "profiles",
      "edit",
      "Gateway",
      "--agent",
      "codex",
      "--query-file=-",
      "--retries",
      "5",
      "--stream-idle-timeout",
      "300000",
    ],
    `api-version=${SECRET}\n`,
  );
  expect(codex.exitCode).toBe(0);
  const codexGateway = profile("codex-gate0001");
  expect(codexGateway.connection?.method === "custom" && codexGateway.connection.advanced).toEqual({
    query: { "api-version": SECRET },
    retries: 5,
    streamIdleTimeoutMs: 300000,
  });
  expect(bodyOf(app.asked[1]?.change)).toBe(
    [
      "에이전트 Codex",
      "재시도 횟수 auto → 5",
      "스트림 제한 시간 (ms) auto → 300000",
      "쿼리 파라미터 api-version 추가",
    ].join("\n"),
  );

  app.answers.push("once");
  const unset = await cli(
    [
      "chat",
      "profiles",
      "edit",
      "Gateway",
      "--agent",
      "claude",
      "--env-file",
      "-",
      "--unset-header",
      "X-Org",
      "--unset-env",
      "HTTPS_PROXY",
    ],
    `TOKEN=${SECRET}-2\n`,
  );
  expect(unset.exitCode).toBe(0);
  expect(profile("claude-gate0001").env).toEqual({ TOKEN: `${SECRET}-2` });
  expect(app.asked[2]?.change.profileEdit?.lines).toEqual([
    { field: "env", name: "HTTPS_PROXY", change: "removed" },
    { field: "env", name: "TOKEN", change: "changed" },
    { field: "header", name: "X-Org", change: "removed" },
  ]);

  const view = await cli(["chat", "profiles", "--profile", "claude-gate0001", "--json"], undefined);
  const text = await cli(["chat", "profiles", "--profile", "claude-gate0001"]);
  const everything = JSON.stringify({
    env,
    codex,
    unset,
    view,
    text,
    asked: app.asked,
    bodies: app.asked.map(({ change }) => [bodyOf(change), bodyOf(change, "en")]),
    logs: logged().slice(offsets),
  });
  expect(everything).not.toContain(SECRET);
});

test("secret values on the command line are refused without echoing them", async () => {
  const { app, cli, profile } = fixture();
  const attempts = [
    ["--env", `TOKEN=${SECRET}`],
    ["--header", `X-Org: ${SECRET}`],
    ["--unset-env", `TOKEN=${SECRET}`],
    ["--unset-header", `X-Org: ${SECRET}`],
    [`--env-file=${SECRET}`],
  ];
  for (const flags of attempts) {
    const result = await cli([
      "chat",
      "profiles",
      "edit",
      "Gateway",
      "--agent",
      "claude",
      ...flags,
    ]);
    expect(result.exitCode, flags[0]).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`, flags[0]).not.toContain(SECRET);
  }
  expect(app.asked).toEqual([]);
  expect(profile("claude-gate0001").env).toBeUndefined();
  const twoStdin = await cli(
    [
      "chat",
      "profiles",
      "edit",
      "Gateway",
      "--agent",
      "claude",
      "--env-file",
      "-",
      "--header-file",
      "-",
    ],
    "A=1\n",
  );
  expect(twoStdin.stderr).toContain("can read stdin");
  const badLine = await cli(
    ["chat", "profiles", "edit", "Gateway", "--agent", "claude", "--env-file", "-"],
    `not a pair ${SECRET}\n`,
  );
  expect(badLine.stderr).toContain("line 1 is not KEY=VALUE");
  expect(badLine.stderr).not.toContain(SECRET);
  const reserved = await cli(
    ["chat", "profiles", "edit", "Gateway", "--agent", "claude", "--env-file", "-"],
    `NEXUS_TOKEN=${SECRET}\n`,
  );
  expect(reserved.stderr).toContain("NEXUS_TOKEN starts with NEXUS_");
  expect(reserved.stderr).not.toContain(SECRET);
  expect(app.asked).toEqual([]);
});

test("edit refuses advanced values Settings would not take, before asking", async () => {
  const { app, cli, profile } = fixture();
  const before = JSON.stringify(profile("claude-gate0001"));
  const cases: [string[], string][] = [
    [["Gateway", "--agent", "claude", "--timeout", "0"], "whole number from 1 to 2147483647"],
    [["Gateway", "--agent", "claude", "--timeout", "2147483648"], "whole number from 1"],
    [["Gateway", "--agent", "claude", "--timeout", "1e3"], "whole number from 1"],
    [["Gateway", "--agent", "claude", "--max-output-tokens", "-5"], "whole number from 1"],
    [["Gateway", "--agent", "codex", "--retries", "101"], "whole number from 0 to 100"],
    [["Gateway", "--agent", "claude", "--retries", "3"], "--retries is for Codex profiles"],
    [["Gateway", "--agent", "codex", "--timeout", "3"], "--timeout is for Claude profiles"],
    [["Gateway", "--agent", "claude", "--query-file", "-"], "--query-file is for Codex profiles"],
    [["Gateway", "--agent", "claude", "--experimental-headers", "maybe"], "takes on or off"],
    [["Work", "--timeout", "1000"], "need a custom connection"],
    [["Work", "--share", "secrets.json"], "--share and --unshare take CLAUDE.md"],
    [["Work", "--share", "skills", "--unshare", "skills"], "in both --share and --unshare"],
    [
      ["default", "--agent", "claude", "--share", "skills"],
      "the default folder; it shares nothing",
    ],
    [["Gateway", "--agent", "claude", "--unset-env", "MISSING"], "MISSING is not set"],
    [["Work", "--behavior", "nope=1"], "--behavior takes ID=VALUE with ID one of model"],
    [["Gateway", "--agent", "claude", "--behavior", "model=opus"], "default model sets it"],
    [["Gateway", "--agent", "codex", "--behavior", "webSearch=live"], "does not use it"],
    [["Work", "--behavior", "permissionMode=bypassPermissions"], "takes plan, acceptEdits"],
    [["Build", "--behavior", "approvalPolicy=untrusted"], "takes on-request, never, default"],
    [["Work", "--behavior", "sandbox=maybe"], "takes on, off or default"],
    [["Build", "--behavior", "autoCompactLimit=-1"], "whole number or default"],
    [["Work", "--unshare", "settings.json", "--behavior", "thinking=off"], "in two commands"],
    [["Work", "--device", "Mini", "--timeout", "1"], "--device is not taken here"],
  ];
  for (const [args, message] of cases) {
    const result = await cli(["chat", "profiles", "edit", ...args]);
    expect(result.exitCode, args.join(" ")).not.toBe(0);
    expect(result.stderr, args.join(" ")).toContain(message);
  }
  expect(app.asked).toEqual([]);
  expect(JSON.stringify(profile("claude-gate0001"))).toBe(before);
});

test("edit refuses the sandbox behavior on Windows as Settings hides it", async () => {
  const { app, cli } = profileFixture(dirOf(), { windows: true });
  const result = await cli(["chat", "profiles", "edit", "Work", "--behavior", "sandbox=off"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--behavior sandbox: it is not available on Windows");
  const unknown = await cli(["chat", "profiles", "edit", "Work", "--behavior", "nope=1"]);
  expect(unknown.stderr).toContain("--behavior takes ID=VALUE with ID one of model");
  expect(unknown.stderr).toContain("attribution");
  expect(unknown.stderr).not.toContain("sandbox");
  expect(app.asked).toEqual([]);
  const elsewhere = profileFixture(dirOf());
  const listed = await elsewhere.cli(["chat", "profiles", "edit", "Work", "--behavior", "nope=1"]);
  expect(listed.stderr).toContain("attribution, sandbox");
});

test("unsharing the behavior file keeps its values in a profile-only copy, as Settings does", async () => {
  const { app, cli, profile } = fixture();
  const settings = `${JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2)}\n`;
  await writeFile(join(dirOf(), "default-claude", "settings.json"), settings);
  await writeFile(join(dirOf(), "default-claude", "CLAUDE.md"), "# shared\n");
  await mkdir(join(dirOf(), "work"), { recursive: true });
  for (const name of ["settings.json", "CLAUDE.md"]) {
    await symlink(join(dirOf(), "default-claude", name), join(dirOf(), "work", name));
  }
  app.answers.push("deny");
  const denied = await cli([
    "chat",
    "profiles",
    "edit",
    "Work",
    "--unshare",
    "settings.json",
    "--unshare",
    "CLAUDE.md",
  ]);
  expect(denied.exitCode).toBe(1);
  expect((await lstat(join(dirOf(), "work", "settings.json"))).isSymbolicLink()).toBe(true);
  expect(app.asked[0]?.change.profileEdit?.lines).toEqual([
    {
      field: "shared",
      value: "CLAUDE.md, settings.json, skills, agents, commands → skills, agents, commands",
    },
    { field: "sharedCopy", file: "settings.json" },
    { field: "sharedUnlinked", files: "CLAUDE.md" },
  ]);
  expect(bodyOf(app.asked[0]?.change)).toBe(
    [
      "에이전트 Claude",
      "기본 폴더와 공유 CLAUDE.md, settings.json, skills, agents, commands → skills, agents, commands",
      "settings.json 프로필 전용 사본으로 바꿈 · 지금 값 유지",
      "CLAUDE.md 링크 지움 · 이 프로필에서 빠짐",
    ].join("\n"),
  );
  expect(bodyOf(app.asked[0]?.change, "en")).toContain(
    "settings.json becomes a profile-only copy · current values kept",
  );

  app.answers.push("once");
  const done = await cli([
    "chat",
    "profiles",
    "edit",
    "Work",
    "--unshare",
    "settings.json",
    "--unshare",
    "CLAUDE.md",
    "--json",
  ]);
  expect(done.stderr).toBe("");
  expect(done.exitCode).toBe(0);
  expect(JSON.parse(done.stdout).changed).toEqual(["shared"]);
  const own = join(dirOf(), "work", "settings.json");
  expect((await lstat(own)).isSymbolicLink()).toBe(false);
  expect(await readFile(own, "utf8")).toBe(settings);
  expect(await readFile(join(dirOf(), "default-claude", "settings.json"), "utf8")).toBe(settings);
  expect(await lstat(join(dirOf(), "work", "CLAUDE.md")).catch(() => null)).toBeNull();
  expect(profile("claude-work0001").shared).toEqual(["skills", "agents", "commands"]);

  app.answers.push("once");
  const shareAgain = await cli(["chat", "profiles", "edit", "Work", "--unshare", "skills"]);
  expect(shareAgain.exitCode).toBe(0);
  expect(app.asked[2]?.change.profileEdit?.lines).toEqual([
    { field: "shared", value: "skills, agents, commands → agents, commands" },
  ]);
});

test("edit changes timeouts, shared files and behavior, marking wider permissions", async () => {
  const { app, cli, profile } = fixture();
  await writeFile(join(dirOf(), "default-claude", "CLAUDE.md"), "# shared\n");
  await writeFile(join(dirOf(), "default-claude", "settings.json"), "{}\n");
  await mkdir(join(dirOf(), "work"), { recursive: true });
  await symlink(
    join(dirOf(), "default-claude", "settings.json"),
    join(dirOf(), "work", "settings.json"),
  );
  await writeFile(
    join(dirOf(), "default-claude", "settings.json"),
    `${JSON.stringify({ permissions: { defaultMode: "plan" }, sandbox: { enabled: true } }, null, 2)}\n`,
  );
  app.answers.push("once");
  const behavior = await cli([
    "chat",
    "profiles",
    "edit",
    "Work",
    "--behavior",
    "permissionMode=acceptEdits",
    "--behavior",
    "sandbox=off",
    "--behavior",
    "thinking=on",
    "--unshare",
    "skills",
    "--json",
  ]);
  expect(behavior.stderr).toBe("");
  expect(behavior.exitCode).toBe(0);
  const lines = app.asked[0]?.change.profileEdit?.lines;
  expect(lines).toEqual([
    {
      field: "shared",
      value:
        "CLAUDE.md, settings.json, skills, agents, commands → CLAUDE.md, settings.json, agents, commands",
    },
    { field: "behavior", id: "permissionMode", from: "plan", to: "acceptEdits", wider: true },
    { field: "behavior", id: "sandbox", from: true, to: null, wider: true },
    { field: "behaviorShared", file: "settings.json" },
  ]);
  expect(bodyOf(app.asked[0]?.change)).toContain("권한 모드 plan → acceptEdits · 권한 넓어짐");
  expect(bodyOf(app.asked[0]?.change)).toContain("Bash 샌드박스 켜짐 → 기본값 · 권한 넓어짐");
  const written = JSON.parse(
    await readFile(join(dirOf(), "default-claude", "settings.json"), "utf8"),
  );
  expect(written).toEqual({ permissions: { defaultMode: "acceptEdits" } });
  expect(profile("claude-work0001").shared).toEqual([
    "CLAUDE.md",
    "settings.json",
    "agents",
    "commands",
  ]);
  const json = JSON.parse(behavior.stdout);
  expect(json.behavior).toMatchObject({
    file: "settings.json",
    sharedWithDefault: true,
    values: { permissionMode: "acceptEdits" },
  });
  expect(json.changed).toEqual(["shared", "behavior"]);

  app.answers.push("once");
  const narrower = await cli([
    "chat",
    "profiles",
    "edit",
    "Work",
    "--behavior",
    "permissionMode=plan",
  ]);
  expect(narrower.exitCode).toBe(0);
  expect(app.asked[1]?.change.profileEdit?.lines?.[0]).toEqual({
    field: "behavior",
    id: "permissionMode",
    from: "acceptEdits",
    to: "plan",
  });

  app.answers.push("once");
  const timeout = await cli([
    "chat",
    "profiles",
    "edit",
    "Gateway",
    "--agent",
    "claude",
    "--timeout",
    "600000",
    "--max-output-tokens",
    "32000",
    "--experimental-headers",
    "off",
  ]);
  expect(timeout.exitCode).toBe(0);
  const gateway = profile("claude-gate0001");
  expect(gateway.connection?.method === "custom" && gateway.connection.advanced).toEqual({
    timeoutMs: 600000,
    maxOutputTokens: 32000,
    disableExperimentalBetas: true,
  });
  expect(bodyOf(app.asked[2]?.change)).toBe(
    [
      "에이전트 Claude",
      "응답 제한 시간 (ms) auto → 600000",
      "최대 출력 토큰 auto → 32000",
      "실험 기능 헤더 켜짐 → 꺼짐",
    ].join("\n"),
  );
  app.answers.push("once");
  const cleared = await cli([
    "chat",
    "profiles",
    "edit",
    "Gateway",
    "--agent",
    "claude",
    "--timeout",
    "auto",
  ]);
  expect(cleared.exitCode).toBe(0);
  const after = profile("claude-gate0001");
  expect(
    after.connection?.method === "custom" && after.connection.advanced?.timeoutMs,
  ).toBeUndefined();
  app.answers.push("once");
  const headersOn = await cli([
    "chat",
    "profiles",
    "edit",
    "Gateway",
    "--agent",
    "claude",
    "--experimental-headers",
    "on",
    "--json",
  ]);
  expect(headersOn.exitCode).toBe(0);
  expect(JSON.parse(headersOn.stdout).changed).toEqual(["advanced"]);
  expect(bodyOf(app.asked[4]?.change)).toBe("에이전트 Claude\n실험 기능 헤더 꺼짐 → 켜짐");
  expect(bodyOf(app.asked[4]?.change, "en")).toBe("Agent Claude\nExperimental headers off → on");
});

test("a behavior file changed while the approval waits saves nothing", async () => {
  const { app, cli, profile } = fixture();
  await mkdir(join(dirOf(), "build"), { recursive: true });
  const file = join(dirOf(), "build", "config.toml");
  await writeFile(file, 'approval_policy = "on-request"\n');
  const ask = app.services.askUser;
  app.services = {
    ...app.services,
    askUser: async (request, signal) => {
      await writeFile(file, 'approval_policy = "on-request"\nmodel = "gpt"\n');
      await ask(request, signal);
    },
  };
  app.answers.push("once");
  const raced = await cli([
    "chat",
    "profiles",
    "edit",
    "Build",
    "--behavior",
    "approvalPolicy=never",
    "--behavior",
    "sandboxMode=danger-full-access",
    "--name",
    "Builder",
  ]);
  expect(raced.exitCode).toBe(1);
  expect(raced.stderr).toContain("behavior file changed while waiting for approval");
  expect(await readFile(file, "utf8")).toBe('approval_policy = "on-request"\nmodel = "gpt"\n');
  expect(profile("codex-build001").name).toBe("Build");
  expect(app.asked[0]?.change.profileEdit?.lines).toEqual([
    { field: "name", value: "Build → Builder" },
    { field: "behavior", id: "approvalPolicy", from: "on-request", to: "never", wider: true },
    { field: "behavior", id: "sandboxMode", from: null, to: "danger-full-access", wider: true },
  ]);
});

test("edits made while the approval waits are refused and denial saves nothing", async () => {
  const { app, cli, profile, state, config } = fixture();
  app.answers.push("deny");
  const denied = await cli(
    ["chat", "profiles", "edit", "Gateway", "--agent", "claude", "--env-file", "-"],
    `TOKEN=${SECRET}\n`,
  );
  expect(denied.exitCode).toBe(1);
  expect(profile("claude-gate0001").env).toBeUndefined();
  const ask = app.services.askUser;
  app.services = {
    ...app.services,
    askUser: async (request, signal) => {
      state.commitState({
        agentProfiles: {
          ...config(),
          profiles: config().profiles.map((p) => ({ ...p, color: "rose" })),
        },
      });
      await ask(request, signal);
    },
  };
  app.answers.push("once");
  const raced = await cli(
    ["chat", "profiles", "edit", "Gateway", "--agent", "claude", "--env-file", "-"],
    `TOKEN=${SECRET}\n`,
  );
  expect(raced.stderr).toContain("The profile changed while waiting for approval");
  expect(profile("claude-gate0001").env).toBeUndefined();
});

test("profiles view shows shared files, variable names and behavior on this computer only", async () => {
  const { app, cli, state, config } = fixture();
  state.commitState({
    agentProfiles: {
      ...config(),
      profiles: config().profiles.map((p) =>
        p.id === "claude-work0001" ? { ...p, env: { TOKEN: SECRET }, shared: ["CLAUDE.md"] } : p,
      ),
    },
  });
  await mkdir(join(dirOf(), "work"), { recursive: true });
  await writeFile(join(dirOf(), "work", "settings.json"), '{"language":"korean"}\n');
  app.uiAnswers.set("chat.profiles", {
    profiles: config().profiles.map(({ id, name, agent }) => ({
      id,
      name,
      agent,
      isDefault: false,
      workspaceDefault: false,
    })),
  });
  const one = await cli(["chat", "profiles", "--profile", "Work", "--json"]);
  const row = JSON.parse(one.stdout).profiles[0];
  expect(row).toMatchObject({
    id: "claude-work0001",
    shared: ["CLAUDE.md"],
    env: ["TOKEN"],
    behavior: { file: "settings.json", sharedWithDefault: false, values: { language: "korean" } },
  });
  const text = await cli(["chat", "profiles", "--profile", "Work"]);
  expect(text.stdout).toContain("Work (claude-work0001) · shared CLAUDE.md · env TOKEN");
  expect(text.stdout).toContain("Behavior settings.json · language korean");
  const all = await cli(["chat", "profiles", "--json"]);
  expect(
    JSON.parse(all.stdout).profiles.find((p: { id: string }) => p.id === "claude-work0001")
      .behavior,
  ).toBeUndefined();
  expect(JSON.stringify([one, text, all])).not.toContain(SECRET);
});

test("edit help names the file-only values, behavior and timeouts", async () => {
  const { cli } = fixture();
  const edit = await cli(["chat", "profiles", "edit", "--help"]);
  for (const flag of [
    "--env-file FILE",
    "--header-file FILE",
    "--behavior ID=VALUE",
    "--timeout MS",
  ]) {
    expect(edit.stdout).toContain(flag);
  }
  expect(edit.stdout).toContain("Values are never printed");
  expect(edit.stdout).toContain("Codex gets query values on its process command line");
});
