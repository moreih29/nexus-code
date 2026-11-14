/** What this device serves the others: its sessions, as the CLI's services see them. */
import { describe, expect, test } from "bun:test";
import { MAX_LISTED_NOTES, RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { CliServices, PendingConsent } from "../../../../../src/main/features/cli/context";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { AgentGate } from "../../../../../src/main/features/remote/agent-gate";
import type { RemoteRepository } from "../../../../../src/main/features/remote/git";
import {
  looksLike,
  MAX_PHOTOS_PER_MINUTE,
  PhotoQuota,
  type RemoteNotes,
} from "../../../../../src/main/features/remote/notes";
import { listSessions, servesWith, serveWith } from "../../../../../src/main/features/remote/serve";
import { MANAGER_WORKSPACE_ID } from "../../../../../src/shared/manager/manager";

function services(pending: PendingConsent[] = []): CliServices {
  const workspaces = [
    { id: "w1", name: "app", rootPath: "/src/app" },
    { id: "w2", name: "feat", rootPath: "/src/app-feat", task: { parentId: "w1", branch: "feat" } },
    { id: "w3", name: "closed", rootPath: "/src/closed" },
  ];
  const tabs: Record<string, { id: string; type: string; title: string }[]> = {
    w1: [
      { id: "t1", type: "claude", title: "Fix the build" },
      { id: "t2", type: "terminal", title: "zsh" },
      { id: "t3", type: "editor", title: "a.ts" },
    ],
    w2: [{ id: "t4", type: "codex", title: "Review" }],
    [MANAGER_WORKSPACE_ID]: [],
  };
  return {
    clock: { now: () => 1000, sleep: async () => {} },
    listWorkspaces: () => workspaces,
    managerWorkspace: () => ({ id: MANAGER_WORKSPACE_ID, name: "Manager", rootPath: "/manager" }),
    claudeAsks: (_w: string, tab: string) =>
      tab === "t2" ? [{ id: "h1", tool: "Bash", target: "rm -rf dist", always: [], since: 5 }] : [],
    claudeStatus: (_w: string, tab: string) =>
      tab === "t2" ? { status: "permissionPending", message: "Allow rm?", since: 5 } : null,
    activity: () => null,
    consents: {
      list: () => pending,
      answer: async (id: string) => {
        const at = pending.findIndex((p) => p.id === id);
        if (at >= 0) pending.splice(at, 1);
        return at >= 0;
      },
    },
    ui: async (op: string, args: { workspaceId: string; tabId?: string }) => {
      if (op === "tabs.list") {
        const list = tabs[args.workspaceId];
        if (!list) throw new Error("not open");
        return { tabs: list };
      }
      if (args.tabId === "t1") {
        return {
          agent: "claude",
          state: "asking",
          message: "May I run\n  bun test?",
          since: 10,
          profile: "work",
          request: { id: "r1", tool: "Bash", input: "bun test" },
          waiting: { kind: "permission", text: "Bash bun\ntest" },
        };
      }
      return { agent: "codex", state: "working", since: 20 };
    },
  } as unknown as CliServices;
}

describe("serving the sessions", () => {
  test("lists the chats and terminals of every workspace, in the app's order", async () => {
    const git = (w: { id: string }) =>
      w.id === "w2" ? { branch: "feat", ahead: 2, behind: 0, uncommitted: 3 } : undefined;
    const list = await listSessions(services(), git);
    expect(list.workspaces.map((w) => w.id)).toEqual(["w1", "w2", "w3", MANAGER_WORKSPACE_ID]);
    expect(list.workspaces[0]).toEqual({ id: "w1", name: "app", path: "/src/app" });
    // A task names its parent and how its branch stands; the manager's says it is the manager's.
    expect(list.workspaces[1]).toMatchObject({
      parentId: "w1",
      git: { branch: "feat", ahead: 2, behind: 0, uncommitted: 3 },
    });
    expect(list.workspaces[3]).toMatchObject({ manager: true });
    expect(list.sessions).toEqual([
      {
        workspaceId: "w1",
        tabId: "t1",
        kind: "claude",
        title: "Fix the build",
        state: "needs-you",
        since: 10,
        last: "May I run bun test?",
        profile: "work",
        waiting: { kind: "permission", text: "Bash bun test" },
      },
      {
        workspaceId: "w1",
        tabId: "t2",
        kind: "terminal",
        title: "zsh",
        state: "needs-you",
        since: 5,
        last: "Allow rm?",
        // What the terminal's Claude Code asks, as the app holds it.
        waiting: { kind: "permission", text: "Bash rm -rf dist", requestId: "h1" },
      },
      {
        workspaceId: "w2",
        tabId: "t4",
        kind: "codex",
        title: "Review",
        state: "running",
        since: 20,
      },
    ]);
  });

  test("with the consent prompts waiting on the user, as the device asking may answer them", async () => {
    const pending: PendingConsent[] = [
      {
        id: "c1",
        at: 1000,
        expiresAt: Date.now() + 60_000,
        request: {
          fromWorkspaceId: "w1",
          fromTabId: "t2",
          toWorkspaceId: "w2",
          change: { kind: "terminalNew" },
          timeoutMs: 60_000,
          id: "c1",
        },
      },
    ];
    const serve = (controls: { chat: boolean; terminal: boolean }) =>
      serveWith(() => services(pending), {
        controls: () => controls,
        deviceName: (id) => (id === "phone" ? "iPhone" : undefined),
      });
    const listed = (await serve({ chat: true, terminal: false })({
      from: "phone",
      method: "sessions.list",
      params: {},
    })) as { consents: { id: string; answerable: boolean; from: object }[] };
    expect(listed.consents).toHaveLength(1);
    expect(listed.consents[0]).toMatchObject({
      id: "c1",
      answerable: false,
      from: { workspaceName: "app", name: "zsh" },
    });
    // A terminal's change needs the terminals' controls too.
    await expect(
      serve({ chat: true, terminal: false })({
        from: "phone",
        method: "consent.answer",
        params: { id: "c1", answer: "once" },
      }),
    ).rejects.toMatchObject({ code: 1002 });
    expect(
      await serve({ chat: true, terminal: true })({
        from: "phone",
        method: "consent.answer",
        params: { id: "c1", answer: "once" },
      }),
    ).toEqual({});
    expect(pending).toEqual([]);
  });

  test("is unavailable until the app made its services, and serves nothing else yet", async () => {
    await expect(
      serveWith(() => null)({ from: "d", method: "sessions.list", params: {} }),
    ).rejects.toMatchObject({ code: 1003 });
    await expect(
      serveWith(services)({ from: "d", method: "chat.watch", params: {} }),
    ).rejects.toMatchObject({ code: -32601 });
  });
});

describe("serving a chat and a terminal to read", () => {
  /** The services, recording the UI requests other than the tabs' list. */
  function recording(answer: (op: string) => unknown = () => ({ text: "$ ls" })) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; tabId?: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args as { workspaceId: string });
        asked.push([op, args]);
        const a = answer(op);
        if (a instanceof Error) throw a;
        return a;
      },
    } as unknown as CliServices;
    return { s, asked };
  }

  test("reads a chat's page from the app, as asked", async () => {
    const { s, asked } = recording(() => ({ start: 0, total: 0, items: [] }));
    await serveWith(() => s)({
      from: "d",
      method: "chat.read",
      params: { workspaceId: "w1", tabId: "t1", before: 40, limit: 20 },
    });
    expect(asked).toEqual([
      ["chat.page", { workspaceId: "w1", tabId: "t1", before: 40, limit: 20 }],
    ]);
  });

  test("reads a terminal's last 1000 lines unless told", async () => {
    const { s, asked } = recording();
    const read = (params: object) =>
      serveWith(() => s)({ from: "d", method: "terminal.read", params });
    expect(await read({ workspaceId: "w1", tabId: "t2" })).toEqual({ text: "$ ls" });
    await read({ workspaceId: "w1", tabId: "t2", lines: 50 });
    expect(asked.map(([, a]) => (a as { lines: number }).lines)).toEqual([1000, 50]);
    // With its colors, when asked.
    await read({ workspaceId: "w1", tabId: "t2", ansi: true });
    expect(asked.at(-1)?.[1]).toMatchObject({ ansi: true });
  });

  test("a terminal's text too long for a frame: its end, from a line's start", async () => {
    const line = `\x1b[0;31m${"x".repeat(990)}\x1b[0m`;
    const { s } = recording(() => ({ text: Array.from({ length: 1000 }, () => line).join("\n") }));
    const { text } = (await serveWith(() => s)({
      from: "d",
      method: "terminal.read",
      params: { workspaceId: "w1", tabId: "t2", ansi: true },
    })) as { text: string };
    expect(text.length).toBeLessThan(1000 * line.length);
    expect(text.startsWith("\x1b[0;31m")).toBe(true);
  });

  test("a tab that is not there, or not of that kind, is not found", async () => {
    const { s, asked } = recording();
    const serve = serveWith(() => s);
    for (const params of [
      { workspaceId: "nope", tabId: "t1" },
      { workspaceId: "w1", tabId: "nope" },
      { workspaceId: "w1", tabId: "t3" },
      { workspaceId: "w3", tabId: "t1" },
    ]) {
      await expect(serve({ from: "d", method: "chat.read", params })).rejects.toMatchObject({
        code: 1001,
      });
    }
    await expect(
      serve({ from: "d", method: "terminal.read", params: { workspaceId: "w1", tabId: "t1" } }),
    ).rejects.toMatchObject({ code: 1001 });
    expect(asked).toEqual([]);
  });

  test("the app failing to read it is unavailable, saying why", async () => {
    const { s } = recording(() => new Error("that tab is gone"));
    await expect(
      serveWith(() => s)({
        from: "d",
        method: "chat.read",
        params: { workspaceId: "w1", tabId: "t1" },
      }),
    ).rejects.toMatchObject({ code: 1003, message: "that tab is gone" });
  });
});

describe("what this device serves", () => {
  test("its chats' controls only when the user allows them", () => {
    expect(servesWith(true)).toContain("chat.control");
    expect(servesWith(false)).not.toContain("chat.control");
    expect(servesWith(false)).toContain("chat.read");
  });

  test("terminal control only while the user allows it, apart from chat control", () => {
    expect(servesWith(true)).not.toContain("terminal.control");
    expect(servesWith(false, true)).toContain("terminal.control");
    expect(servesWith(false, true)).not.toContain("chat.control");
    expect(servesWith(true, true)).toEqual(
      expect.arrayContaining(["chat.control", "terminal.control"]),
    );
  });

  test("agents' requests unless the user turned them down", () => {
    expect(servesWith(false, false, true)).toContain("agents");
    expect(servesWith(true, true, false)).not.toContain("agents");
  });
});

describe("serving a workspace's notes", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");
  function notes(over: Partial<RemoteNotes> = {}) {
    const attached: { workspaceId: string; noteId: string; ext: string; name?: string }[] = [];
    const remote: RemoteNotes = {
      list: async (workspaceId) =>
        workspaceId === "w1"
          ? Array.from({ length: 60 }, (_, i) => ({
              id: `n${i}`,
              title: `note ${i}`,
              updatedAt: 1000 - i,
              excerpt: "not sent",
            }))
          : [],
      attach: async (workspaceId, noteId, _bytes, ext, name) => {
        if (noteId === "gone")
          throw Object.assign(new Error("no note gone"), { code: "not-found" });
        attached.push({ workspaceId, noteId, ext, ...(name ? { name } : {}) });
        return { src: `screens/${name ?? "photo"}.${ext}` };
      },
      recording: () => undefined,
      ...over,
    };
    return { remote, attached };
  }
  const ask = (remote: RemoteNotes, method: "notes.list" | "notes.attach", params: object) =>
    serveWith(() => services(), { notes: remote })({ from: "phone", method, params });

  test("lists a workspace's notes, the last changed first, at most a page, with only what a phone needs", async () => {
    const { remote } = notes();
    const listed = (await ask(remote, "notes.list", { workspaceId: "w1" })) as {
      notes: object[];
    };
    expect(listed.notes).toHaveLength(MAX_LISTED_NOTES);
    expect(listed.notes[0]).toEqual({ id: "n0", title: "note 0", updatedAt: 1000 });
    await expect(ask(remote, "notes.list", { workspaceId: "nope" })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
    });
  });

  test("puts a photo into a note as the type it says, and refuses bytes that are not that image", async () => {
    const { remote, attached } = notes();
    const photo = { workspaceId: "w1", noteId: "n1", mediaType: "image/jpeg", data: JPEG };
    expect(await ask(remote, "notes.attach", { ...photo, name: " IMG_0001 " })).toEqual({
      src: "screens/IMG_0001.jpg",
    });
    expect(attached).toEqual([{ workspaceId: "w1", noteId: "n1", ext: "jpg", name: "IMG_0001" }]);
    await expect(
      ask(remote, "notes.attach", { ...photo, mediaType: "image/png" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    await expect(ask(remote, "notes.attach", { ...photo, noteId: "gone" })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
    });
    expect(attached).toHaveLength(1);
  });

  test("thirty photos a minute from one device; more wait for the minute to pass", async () => {
    const { remote, attached } = notes();
    let now = 0;
    const serve = serveWith(() => services(), {
      notes: remote,
      photoQuota: new PhotoQuota(MAX_PHOTOS_PER_MINUTE, () => now),
    });
    const photo = { workspaceId: "w1", noteId: "n1", mediaType: "image/jpeg", data: JPEG };
    const attach = (from: string) => serve({ from, method: "notes.attach", params: photo });
    for (let i = 0; i < MAX_PHOTOS_PER_MINUTE; i++) await attach("phone");
    await expect(attach("phone")).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
    // Another device has its own share.
    await attach("tablet");
    now += 60_000;
    await attach("phone");
    expect(attached).toHaveLength(MAX_PHOTOS_PER_MINUTE + 2);
  });

  test("the sessions' list tells the note being recorded into, while one is", async () => {
    const recording = {
      workspaceId: "w1",
      noteId: "n1",
      title: "주간 회의",
      recordedMs: 5000,
      at: 1000,
      paused: true,
    };
    const list = (rec?: typeof recording) =>
      serveWith(() => services(), { notes: notes({ recording: () => rec }).remote })({
        from: "phone",
        method: "sessions.list",
        params: {},
      }) as Promise<{ recording?: object }>;
    expect((await list(recording)).recording).toEqual(recording);
    expect(await list()).not.toHaveProperty("recording");
  });

  test("whatever the user lets other devices control", () => {
    expect(servesWith(false, false, false)).toContain("notes");
  });

  test("an image is known by its first bytes", () => {
    expect(looksLike(Buffer.from(JPEG, "base64"), "image/jpeg")).toBe(true);
    expect(looksLike(Buffer.from("\x89PNG\r\n", "latin1"), "image/png")).toBe(true);
    expect(looksLike(Buffer.from("GIF89a", "latin1"), "image/gif")).toBe(true);
    expect(looksLike(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), "image/webp")).toBe(true);
    expect(looksLike(Buffer.from("<svg>", "latin1"), "image/png")).toBe(false);
  });
});

describe("serving a workspace's files found, and a commit", () => {
  const agentFs = {
    kind: "ssh",
    onAgentLifecycle: () => () => {},
    onAgentEvent: () => () => {},
    callAgentMethod: async (method: string) =>
      method === "search.files"
        ? { files: ["src/a.ts"], truncated: false }
        : { filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 },
  } as unknown as FsProvider;
  const serve = serveWith(services, {
    files: { fs: async () => agentFs, shrink: () => null },
    repositories: {
      repository: async () =>
        ({
          topLevel: "/src/app",
          commitDetail: async () => ({
            sha: "abcd1234",
            parents: [],
            subject: "First",
            author: "Me",
            authorEmail: "me@example.com",
            committerTs: "2026-01-01T00:00:00Z",
            message: "First",
            body: "",
            files: [],
          }),
          log: async function* () {
            yield { entries: [] };
            return { count: 0 };
          },
        }) as unknown as RemoteRepository,
      readUntracked: async () => "",
    },
  });

  test("by name, for text, and a commit, each in its workspace", async () => {
    expect(
      await serve({ from: "d", method: "files.find", params: { workspaceId: "w1", query: "a" } }),
    ).toEqual({ files: ["src/a.ts"] });
    expect(
      await serve({ from: "d", method: "files.search", params: { workspaceId: "w1", query: "a" } }),
    ).toEqual({ files: [] });
    expect(
      await serve({ from: "d", method: "git.show", params: { workspaceId: "w1", hash: "abcd" } }),
    ).toMatchObject({ hash: "abcd1234", at: Date.parse("2026-01-01T00:00:00Z"), files: [] });
    await expect(
      serve({ from: "d", method: "files.find", params: { workspaceId: "nope", query: "a" } }),
    ).rejects.toMatchObject({ code: 1001 });
  });

  test("two searches of one device's at once; another waits for one to end", async () => {
    const pending: Array<() => void> = [];
    const slowFs = {
      ...agentFs,
      callAgentMethod: (method: string) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve(
              method === "search.files"
                ? { files: [], truncated: false }
                : { filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 },
            ),
          ),
        ),
    } as unknown as FsProvider;
    const slow = serveWith(services, { files: { fs: async () => slowFs, shrink: () => null } });
    const find = (from: string) =>
      slow({ from, method: "files.find", params: { workspaceId: "w1", query: "a" } });
    const first = [find("d"), find("d")];
    await Bun.sleep(0);
    await expect(find("d")).rejects.toMatchObject({
      code: 1003,
      message: expect.stringContaining("2 searches running"),
    });
    // Another device's goes.
    const other = find("e");
    await Bun.sleep(0);
    for (const done of pending.splice(0)) done();
    await Promise.all([...first, other]);
    const again = find("d");
    await Bun.sleep(0);
    for (const done of pending.splice(0)) done();
    expect(await again).toEqual({ files: [] });
  });

  test("not served without the files", async () => {
    await expect(
      serveWith(services)({
        from: "d",
        method: "files.search",
        params: { workspaceId: "w1", query: "a" },
      }),
    ).rejects.toMatchObject({ code: -32601 });
  });
});

describe("serving a chat's settings", () => {
  const choices = {
    agent: "claude",
    model: "sonnet",
    effort: "high",
    mode: "default",
    models: [{ value: "sonnet", name: "Sonnet" }],
    efforts: ["low", "high"],
  };
  function settingsServices(now: Record<string, unknown> = choices) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        return now;
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }
  const tab = { workspaceId: "w1", tabId: "t1" };

  test("tells what the chat runs with and every mode it may take, the dangerous one marked", async () => {
    const { serve } = settingsServices();
    const got = (await serve({ from: "d", method: "chat.settings", params: tab })) as {
      model: string;
      options: { models: unknown[]; modes: { id: string; dangerous?: boolean }[] };
    };
    expect(got).toMatchObject({ agent: "claude", model: "sonnet", permissionMode: "default" });
    expect(got.options.models).toEqual([{ id: "sonnet", label: "Sonnet" }]);
    expect(got.options.modes.map((m) => m.id)).toContain("acceptEdits");
    expect(got.options.modes.find((m) => m.dangerous)?.id).toBe("bypassPermissions");
  });

  test("sets them as the user, and refuses the dangerous mode a policy turned off", async () => {
    const { serve, asked } = settingsServices();
    await serve({
      from: "d",
      method: "chat.configure",
      params: { ...tab, model: "sonnet", permissionMode: "acceptEdits" },
    });
    expect(asked).toEqual([
      ["chat.settings", { ...tab, settings: { model: "sonnet", mode: "acceptEdits" }, user: true }],
    ]);
    const blocked = settingsServices({ ...choices, dangerousBlocked: "disabled by policy" });
    await expect(
      blocked.serve({
        from: "d",
        method: "chat.configure",
        params: { ...tab, permissionMode: "bypassPermissions" },
      }),
    ).rejects.toMatchObject({ code: 1002, message: expect.stringContaining("disabled by policy") });
  });
});

describe("renaming a chat", () => {
  test("as its tab's rename does; refused when only spaces", async () => {
    const asked: unknown[] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; title?: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        return { title: args.title };
      },
    } as unknown as CliServices;
    const serve = serveWith(() => s);
    const params = { workspaceId: "w1", tabId: "t1", title: "Build fix" };
    expect(await serve({ from: "d", method: "chat.rename", params })).toEqual({
      title: "Build fix",
    });
    expect(asked).toEqual([["chat.rename", params]]);
    await expect(
      serve({ from: "d", method: "chat.rename", params: { ...params, title: "   " } }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("serving one tool call", () => {
  const tab = { workspaceId: "w1", tabId: "t1" };
  function toolServices() {
    const asked: number[] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (
        op: string,
        args: { workspaceId: string; toolUseId?: string; maxText?: number },
      ) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        if (args.toolUseId === "nope") throw new Error("no tool call nope in that tab");
        asked.push(args.maxText ?? 0);
        // A result of quotes, twice as long in JSON as it is.
        const text = '"'.repeat(Math.min(args.maxText ?? 0, 600_000));
        return {
          id: "tu1",
          name: "Bash",
          input: {},
          status: "done",
          parentToolUseId: null,
          result: { text, isError: false, images: [] },
        };
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }

  test("with as much of its result as a frame takes, and NotFound for none", async () => {
    const { serve, asked } = toolServices();
    const tool = (await serve({
      from: "d",
      method: "chat.tool",
      params: { ...tab, toolUseId: "tu1" },
    })) as {
      result: { text: string };
    };
    expect(asked.length).toBeGreaterThan(1);
    expect(tool.result.text.length).toBeGreaterThan(100_000);
    await expect(
      serve({ from: "d", method: "chat.tool", params: { ...tab, toolUseId: "nope" } }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});

describe("serving a chat's side panel", () => {
  const tab = { workspaceId: "w1", tabId: "t1" };
  function panelServices(files: number) {
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        if (op === "chat.stopTask") throw new Error("no task b9 in that tab");
        return {
          todos: [],
          tasks: [],
          agents: [],
          changedFiles: Array.from({ length: files }, (_, i) => ({
            path: `/src/app/${"d/".repeat(200)}${i}.ts`,
          })),
          context: null,
          goal: null,
        };
      },
    } as unknown as CliServices;
    return serveWith(() => s);
  }

  test("its changed files cut to what goes in a frame", async () => {
    const few = (await panelServices(3)({ from: "d", method: "chat.panel", params: tab })) as {
      changedFiles: unknown[];
    };
    expect(few.changedFiles).toHaveLength(3);
    const many = (await panelServices(5000)({ from: "d", method: "chat.panel", params: tab })) as {
      changedFiles: unknown[];
    };
    expect(many.changedFiles.length).toBeLessThan(5000);
    expect(many.changedFiles.length).toBeGreaterThan(0);
  });

  test("NotFound for a task the chat does not have", async () => {
    await expect(
      panelServices(0)({ from: "d", method: "chat.stopTask", params: { ...tab, taskId: "b9" } }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});

describe("serving the conversations of the past", () => {
  function historyServices(fail?: string) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: unknown) => {
        asked.push([op, args]);
        if (fail) throw new Error(fail);
        return op === "chat.history"
          ? { sessions: [{ sessionId: "s1", title: "t", at: 1, cwd: "/src/app", profile: "p" }] }
          : { tabId: "t7" };
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }

  test("lists them for a workspace, and opens one in a new chat", async () => {
    const { serve, asked } = historyServices();
    const listed = (await serve({
      from: "d",
      method: "history.list",
      params: { workspaceId: "w1", agent: "claude", query: "build" },
    })) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(1);
    expect(
      await serve({
        from: "d",
        method: "chat.resume",
        params: { workspaceId: "w1", agent: "codex", sessionId: "th1" },
      }),
    ).toEqual({ tabId: "t7" });
    expect(asked).toEqual([
      ["chat.history", { workspaceId: "w1", agent: "claude", query: "build" }],
      ["chat.resume", { workspaceId: "w1", agent: "codex", sessionId: "th1" }],
    ]);
  });

  test("NotFound for no such workspace or conversation", async () => {
    const params = { workspaceId: "nope", agent: "claude", sessionId: "s9" };
    await expect(
      historyServices().serve({ from: "d", method: "chat.resume", params }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(
      historyServices("no conversation s9 in that workspace's folder").serve({
        from: "d",
        method: "chat.resume",
        params: { ...params, workspaceId: "w1" },
      }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});

describe("serving a chat's slash commands", () => {
  const commands = [
    { name: "review", description: "Review", runs: "send" },
    { name: "model", description: "Model", runs: "settings", sets: "model" },
    { name: "btw", description: "Aside", runs: "command", args: "<question>" },
  ];
  function commandServices() {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        return op === "chat.commands" ? { commands } : { message: "an answer" };
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }
  const tab = { workspaceId: "w1", tabId: "t1" };

  test("lists them, and runs one of the app's with what follows it", async () => {
    const { serve, asked } = commandServices();
    expect(await serve({ from: "d", method: "chat.commands", params: tab })).toEqual({ commands });
    const ran = await serve({
      from: "d",
      method: "chat.command",
      params: { ...tab, name: "/btw", args: "why?" },
    });
    expect(ran).toEqual({ message: "an answer" });
    expect(asked.at(-1)).toEqual(["chat.command", { ...tab, name: "btw", args: "why?" }]);
  });

  test("sends the agent's own and the settings elsewhere, and refuses one it does not list", async () => {
    const { serve, asked } = commandServices();
    const run = (name: string) =>
      serve({ from: "d", method: "chat.command", params: { ...tab, name } });
    await expect(run("review")).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("chat.send"),
    });
    await expect(run("model")).rejects.toMatchObject({
      message: expect.stringContaining("chat.configure"),
    });
    await expect(run("logout")).rejects.toMatchObject({ code: -32602 });
    expect(asked.some(([op]) => op === "chat.command")).toBe(false);
  });
});

describe("serving a chat's controls", () => {
  function recording(fail?: string) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        if (fail) throw new Error(fail);
        return op === "chat.open" ? { tabId: "t9" } : {};
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }
  const tab = { workspaceId: "w1", tabId: "t1" };

  test("sends as the user, who may write while the chat asks", async () => {
    const { serve, asked } = recording();
    // When it took it, for a chat.wait's `after`.
    expect(
      await serve({ from: "d", method: "chat.send", params: { ...tab, text: "go on" } }),
    ).toEqual({ at: 1000 });
    expect(asked).toEqual([["chat.send", { ...tab, text: "go on", user: true }]]);
  });

  test("an agent's message, as the user lets agents act here, shows as that agent's", async () => {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        return op === "chat.settings" ? { agent: "claude", models: [], efforts: [] } : {};
      },
    } as unknown as CliServices;
    const from = {
      kind: "tab",
      agent: "claude",
      name: "Fix",
      workspaceId: "bw",
      tabId: "bt",
      hops: 2,
    };
    const params = { ...tab, text: "run the tests", from };
    // Not taken where no gate says agents may.
    await expect(
      serveWith(() => s)({ from: "d", method: "chat.send", params }),
    ).rejects.toMatchObject({ code: 1002 });
    const serve = serveWith(() => s, {
      agents: new AgentGate({ policy: () => "allow" }),
      deviceName: (id) => (id === "d" ? "MacBook" : undefined),
    });
    await serve({ from: "d", method: "chat.send", params });
    expect(asked[0]).toEqual([
      "chat.send",
      {
        ...tab,
        text: "run the tests",
        from: { ...from, device: { id: "d", name: "MacBook" } },
      },
    ]);
    // Its settings never as the user's: no mode that lets everything run.
    await serve({
      from: "d",
      method: "chat.configure",
      params: { ...tab, model: "haiku", from },
    });
    expect(asked.at(-1)?.[1]).not.toHaveProperty("user");
  });

  test("sends the images the device attached with it, once, and nothing empty", async () => {
    const { serve, asked } = recording();
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64");
    const { attachmentId } = (await serve({
      from: "d",
      method: "chat.attach",
      params: { ...tab, mediaType: "image/jpeg", data },
    })) as { attachmentId: string };
    const send = (from: string) =>
      serve({
        from,
        method: "chat.send",
        params: { ...tab, text: "", attachments: [attachmentId] },
      });
    await expect(send("other")).rejects.toMatchObject({ code: -32602 });
    await send("d");
    expect(asked).toEqual([
      ["chat.send", { ...tab, text: "", user: true, images: [{ mediaType: "image/jpeg", data }] }],
    ]);
    await expect(send("d")).rejects.toMatchObject({ code: -32602 });
    await expect(
      serve({ from: "d", method: "chat.send", params: { ...tab, text: "  " } }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("text or an image") });
  });

  test("an image of the chat, small enough for a frame, and NotFound for none", async () => {
    const base = services();
    const asked: unknown[] = [];
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; ref?: { index: number } }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push(args);
        if (args.ref?.index === 9) throw new Error("no such image in that tab");
        return { mediaType: "image/png", data: "AAAA" };
      },
    } as unknown as CliServices;
    const serve = serveWith(() => s);
    const ref = { kind: "user", itemKey: "k1", index: 0 };
    expect(await serve({ from: "d", method: "chat.image", params: { ...tab, ref } })).toEqual({
      mediaType: "image/png",
      data: "AAAA",
    });
    expect(asked[0]).toMatchObject({ ref, maxChars: expect.any(Number) });
    await expect(
      serve({ from: "d", method: "chat.image", params: { ...tab, ref: { ...ref, index: 9 } } }),
    ).rejects.toMatchObject({ code: 1001 });
  });

  test("answers the request it names, with a question's answers or a stop", async () => {
    const { serve, asked } = recording();
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r1", decision: "allow", updatedInput: { answers: { q: "a" } } },
    });
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r2", decision: "deny", message: "no", stop: true },
    });
    expect(asked).toEqual([
      [
        "chat.answer",
        { ...tab, decision: "allow", expect: "r1", updatedInput: { answers: { q: "a" } } },
      ],
      ["chat.answer", { ...tab, decision: "deny", expect: "r2", message: "no", stop: true }],
    ]);
  });

  test("keeps the suggestions the user picked with an allow, and none with a denial", async () => {
    const { serve, asked } = recording();
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r1", decision: "allow", always: [0, 2] },
    });
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r2", decision: "deny", always: [0] },
    });
    expect(asked).toEqual([
      ["chat.answer", { ...tab, decision: "allow", expect: "r1", always: [0, 2] }],
      ["chat.answer", { ...tab, decision: "deny", expect: "r2" }],
    ]);
  });

  test("opens a chat in the workspace's folder, behind what this computer shows", async () => {
    const { serve, asked } = recording();
    const opened = await serve({
      from: "d",
      method: "chat.new",
      params: { workspaceId: "w2", agent: "codex", prompt: "review" },
    });
    expect(opened).toEqual({ tabId: "t9" });
    expect(asked).toEqual([
      [
        "chat.open",
        {
          workspaceId: "w2",
          agent: "codex",
          cwd: "/src/app-feat",
          prompt: "review",
          placement: { background: true },
          user: true,
        },
      ],
    ]);
  });

  test("opens one in a folder of the workspace, with a mode and a profile, and nowhere else", async () => {
    const { serve, asked } = recording();
    await serve({
      from: "d",
      method: "chat.new",
      params: {
        workspaceId: "w2",
        agent: "claude",
        folder: "packages/ui/",
        permissionMode: "acceptEdits",
        profile: "Work",
      },
    });
    expect(asked[0]?.[1]).toMatchObject({
      cwd: "/src/app-feat/packages/ui",
      settings: { mode: "acceptEdits" },
      profile: "Work",
      user: true,
    });
    for (const folder of ["../other", "/etc"]) {
      await expect(
        serve({
          from: "d",
          method: "chat.new",
          params: { workspaceId: "w2", agent: "claude", folder },
        }),
      ).rejects.toMatchObject({ code: 1002 });
    }
  });

  test("lists the profiles a chat may run with", async () => {
    const { serve, asked } = recording();
    await serve({ from: "d", method: "profiles.list", params: { agent: "codex" } });
    expect(asked).toEqual([["chat.profiles", { agent: "codex" }]]);
  });

  test("opens a chat with the model and effort asked, saying when they could not be set", async () => {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        asked.push([op, args]);
        return { tabId: "t9", error: 'claude has no model "gpt"' };
      },
    } as unknown as CliServices;
    const opened = await serveWith(() => s)({
      from: "d",
      method: "chat.new",
      params: { workspaceId: "w2", agent: "claude", prompt: "hi", model: "haiku", effort: "low" },
    });
    expect(opened).toEqual({ tabId: "t9", error: 'claude has no model "gpt"' });
    expect(asked[0]?.[1]).toMatchObject({ settings: { model: "haiku", effort: "low" } });
  });

  test("stops and closes only a chat; the app refusing is unavailable", async () => {
    const { serve, asked } = recording();
    await serve({ from: "d", method: "chat.interrupt", params: tab });
    await serve({ from: "d", method: "chat.close", params: tab });
    expect(asked).toEqual([
      ["chat.interrupt", tab],
      ["tab.close", { ...tab, force: false }],
    ]);
    await expect(
      serve({ from: "d", method: "chat.close", params: { workspaceId: "w1", tabId: "t2" } }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(
      recording("it has no turn to stop").serve({
        from: "d",
        method: "chat.interrupt",
        params: tab,
      }),
    ).rejects.toMatchObject({ code: 1003, message: "it has no turn to stop" });
  });
});

describe("serving what goes in a frame", () => {
  test("a chat page too large for a frame is read again with fewer items", async () => {
    const limits: number[] = [];
    const base = services();
    const big = "x".repeat(150_000);
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; limit?: number }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        const n = args.limit ?? 0;
        limits.push(n);
        return {
          start: 0,
          total: n,
          items: Array.from({ length: n }, (_, i) => ({
            kind: "shell",
            key: `k${i}`,
            command: big,
          })),
        };
      },
    } as unknown as CliServices;
    const page = (await serveWith(() => s)({
      from: "d",
      method: "chat.read",
      params: { workspaceId: "w1", tabId: "t1", limit: 20 },
    })) as { items: unknown[] };
    expect(limits).toEqual([20, 10, 5]);
    expect(page.items).toHaveLength(5);
  });

  test("a terminal's text too large for a frame keeps its end", async () => {
    const base = services();
    const text = `${"a".repeat(2_000_000)}THE END`;
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) =>
        op === "tabs.list" ? base.ui("tabs.list", args) : { text },
    } as unknown as CliServices;
    const read = (await serveWith(() => s)({
      from: "d",
      method: "terminal.read",
      params: { workspaceId: "w1", tabId: "t2" },
    })) as { text: string };
    expect(read.text.endsWith("THE END")).toBe(true);
    expect(read.text.length).toBeLessThan(800_000);
  });
});

describe("serving the sessions' changes", () => {
  const event = (seq: number, message = "done") => ({
    seq,
    at: seq * 10,
    workspaceId: "w1",
    tabId: "t1",
    title: "Fix",
    kind: "claude",
    agent: "claude",
    from: "running",
    to: "done",
    phase: "done",
    message,
    goal: { condition: "x", status: "active", from: null },
  });
  function reading(events: ReturnType<typeof event>[], more = false) {
    const asked: unknown[] = [];
    const s = {
      ...services(),
      ui: async (op: string, args: unknown) => {
        asked.push([op, args]);
        return { events, cursor: events.at(-1)?.seq ?? 0, more };
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }

  test("as nexus events lists them, each message in a line", async () => {
    const { serve, asked } = reading([event(1, "first\nsecond")]);
    expect(await serve({ from: "d", method: "events.read", params: { since: 0 } })).toEqual({
      events: [
        {
          seq: 1,
          at: 10,
          workspaceId: "w1",
          tabId: "t1",
          title: "Fix",
          kind: "claude",
          agent: "claude",
          from: "running",
          to: "done",
          message: "first second",
        },
      ],
      cursor: 1,
      more: false,
    });
    expect(asked).toEqual([["events.read", { since: 0, limit: 100 }]]);
  });

  test("as many as go in a frame: the first after `since`, else the last", async () => {
    // Long titles: 500 changes then take more than a frame.
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...event(i + 1, "x".repeat(500)),
      title: "t".repeat(2000),
    }));
    const after = (await reading(many).serve({
      from: "d",
      method: "events.read",
      params: { since: 0, limit: 500 },
    })) as { events: { seq: number }[]; more: boolean };
    expect(after.events.length).toBeLessThan(500);
    expect(after.events[0]?.seq).toBe(1);
    expect(after.more).toBe(true);
    const last = (await reading(many).serve({
      from: "d",
      method: "events.read",
      params: { limit: 500 },
    })) as { events: { seq: number }[]; more: boolean };
    expect(last.events.at(-1)?.seq).toBe(500);
    expect(last.more).toBe(false);
  });
});
