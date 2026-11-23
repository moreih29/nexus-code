/** The consent prompts waiting on the user here, as another device sees and answers them. */
import { describe, expect, test } from "bun:test";
import { RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { CliServices, PendingConsent } from "../../../../../src/main/features/cli/context";
import {
  answerConsent,
  MAX_REMOTE_BODY_CHARS,
  remoteConsents,
  UNTIMED_EXPIRES_AFTER_MS,
} from "../../../../../src/main/features/remote/consents";
import type { CliChange, CliUiOps } from "../../../../../src/shared/cli/ui";

type AskArgs = CliUiOps["consent.ask"]["args"];

const pendingOf = (id: string, over: Partial<AskArgs> = {}, at = 1000): PendingConsent => ({
  id,
  at,
  expiresAt: at + 60_000,
  request: {
    fromWorkspaceId: "w1",
    fromTabId: "t1",
    toWorkspaceId: "w2",
    change: { kind: "chatInterrupt", detail: "Review" },
    timeoutMs: 60_000,
    id,
    ...over,
  },
});

function setup(pending: PendingConsent[]) {
  const answered: { id: string; answer: string; by: string }[] = [];
  const services = {
    listWorkspaces: () => [
      { id: "w1", name: "app", rootPath: "/app" },
      { id: "w2", name: "api", rootPath: "/api" },
    ],
    ui: async (op: string, args: { workspaceId: string }) => {
      if (op !== "tabs.list") throw new Error(op);
      return {
        tabs: args.workspaceId === "w1" ? [{ id: "t1", type: "terminal", title: "zsh" }] : [],
      };
    },
    consents: {
      list: () => pending,
      answer: async (id: string, answer: string, by: string) => {
        const at = pending.findIndex((p) => p.id === id);
        if (at < 0) return false;
        pending.splice(at, 1);
        answered.push({ id, answer, by });
        return true;
      },
    },
  } as unknown as CliServices;
  return { services, answered };
}

const both = { chat: true, terminal: true };
const phone = { id: "phone", name: "iPhone" };

describe("the consent prompts another device is told", () => {
  test("one that waits until answered says it expires a day after it was asked, for older readers", async () => {
    const { expiresAt: _, ...untimed } = pendingOf("c1");
    const { services } = setup([untimed]);
    const [listed] = await remoteConsents(services, both, 31_000);
    expect(listed?.expiresAt).toBe(1000 + UNTIMED_EXPIRES_AFTER_MS);
    expect(listed?.expiresInMs).toBe(1000 + UNTIMED_EXPIRES_AFTER_MS - 31_000);
    expect(UNTIMED_EXPIRES_AFTER_MS).toBe(24 * 60 * 60_000);
  });

  test("who asks, what it would change, and how long it has left", async () => {
    const terminal: CliChange = { kind: "terminalInput", detail: "zsh", body: "rm -rf dist" };
    const { services } = setup([
      pendingOf("c1"),
      pendingOf("c2", { fromWorkspaceId: "w1", fromTabId: "gone", change: terminal }),
      pendingOf("c3", {
        fromWorkspaceId: "bw",
        fromTabId: "bt",
        fromDevice: "MacBook",
        fromDeviceId: "mac",
        fromName: "Fix build",
        change: { kind: "permissionAllow", detail: "Bash" },
      }),
    ]);
    const listed = await remoteConsents(services, both, 31_000);
    expect(listed[0]).toEqual({
      id: "c1",
      at: 1000,
      expiresAt: 61_000,
      expiresInMs: 30_000,
      from: { workspaceId: "w1", workspaceName: "app", tabId: "t1", name: "zsh" },
      workspaceId: "w2",
      change: { kind: "chatInterrupt", detail: "Review" },
      eachTime: false,
      answerable: true,
    });
    // A tab since closed: no name to tell.
    expect(listed[1]).toMatchObject({
      from: { workspaceId: "w1", workspaceName: "app", tabId: "gone" },
      change: terminal,
    });
    expect(listed[1]?.from).not.toHaveProperty("name");
    // Another computer's agent: its workspace and tab name nothing here.
    expect(listed[2]).toMatchObject({
      from: {
        device: { id: "mac", name: "MacBook" },
        workspaceId: "bw",
        tabId: "bt",
        name: "Fix build",
      },
      eachTime: false,
      answerable: true,
    });
    expect(listed[2]?.from).not.toHaveProperty("workspaceName");
  });

  test("a prompt run out says none left, not less than none", async () => {
    const { services } = setup([pendingOf("c1")]);
    expect((await remoteConsents(services, both, 90_000))[0]?.expiresInMs).toBe(0);
  });

  test("answerable with the controls it needs, the asking agent's device included", async () => {
    const { services } = setup([
      pendingOf("chat"),
      pendingOf("term", { change: { kind: "tabClose", detail: "zsh", terminal: true } }),
      pendingOf("own", { fromDevice: "MacBook", fromDeviceId: "mac" }),
      pendingOf("own term", {
        fromDevice: "MacBook",
        fromDeviceId: "mac",
        change: { kind: "terminalNew" },
      }),
      pendingOf("own long", {
        fromDevice: "MacBook",
        fromDeviceId: "mac",
        change: { kind: "chatInput", body: "x".repeat(MAX_REMOTE_BODY_CHARS + 1) },
      }),
    ]);
    const answerable = async (controls: { chat: boolean; terminal: boolean }) =>
      (await remoteConsents(services, controls)).map((c) => c.answerable);
    expect(await answerable(both)).toEqual([true, true, true, true, false]);
    expect(await answerable({ chat: true, terminal: false })).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(await answerable({ chat: false, terminal: true })).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a body too long to tell whole is cut short, and not answerable from there", async () => {
    const long = "x".repeat(MAX_REMOTE_BODY_CHARS + 5);
    const { services } = setup([
      pendingOf("c1", { change: { kind: "chatInput", detail: "Review", body: long } }),
    ]);
    const [listed] = await remoteConsents(services, both);
    expect(listed?.change.body).toBe(
      `${"x".repeat(MAX_REMOTE_BODY_CHARS)}\n… (5 more characters: see it whole at the computer)`,
    );
    expect(listed?.answerable).toBe(false);
    await expect(
      answerConsent(services, phone, both, { id: "c1", answer: "once" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
  });

  test("none waiting: nothing is looked up", async () => {
    const services = {
      consents: { list: () => [] },
      ui: async () => {
        throw new Error("asked");
      },
    } as unknown as CliServices;
    expect(await remoteConsents(services, both)).toEqual([]);
  });
});

describe("answering one from another device", () => {
  test("answers it as the user would, saying from which device", async () => {
    const { services, answered } = setup([pendingOf("c1")]);
    expect(await answerConsent(services, phone, both, { id: "c1", answer: "session" })).toEqual({});
    expect(answered).toEqual([{ id: "c1", answer: "session", by: "iPhone" }]);
  });

  test("offers until restart for eligible sandbox prompts and accepts the remote answer", async () => {
    const sandbox = { kind: "sandboxExecution", terminal: true } as const;
    const { services, answered } = setup([
      pendingOf("scope", { change: sandbox }),
      pendingOf("once", { change: { ...sandbox, eachTime: true } }),
    ]);
    expect((await remoteConsents(services, both)).map((c) => c.eachTime)).toEqual([false, true]);
    await expect(
      answerConsent(
        services,
        phone,
        { chat: true, terminal: false },
        { id: "scope", answer: "session" },
      ),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    await expect(
      answerConsent(services, phone, both, { id: "once", answer: "session" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(await answerConsent(services, phone, both, { id: "scope", answer: "session" })).toEqual(
      {},
    );
    expect(answered).toEqual([{ id: "scope", answer: "session", by: "iPhone" }]);
  });

  test("one answered or run out since is not found", async () => {
    const { services } = setup([]);
    await expect(
      answerConsent(services, phone, both, { id: "c1", answer: "once" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  });

  test("the asking agent's device answers it as any other, the user at it", async () => {
    const { services, answered } = setup([
      pendingOf("own", { fromDevice: "MacBook", fromDeviceId: "mac" }),
    ]);
    const mac = { id: "mac", name: "MacBook" };
    expect(await answerConsent(services, mac, both, { id: "own", answer: "once" })).toEqual({});
    expect(answered).toEqual([{ id: "own", answer: "once", by: "MacBook" }]);
  });

  test("refused without the controls it needs, the asking agent's device too", async () => {
    const { services, answered } = setup([
      pendingOf("term", { change: { kind: "terminalNew" } }),
      pendingOf("own", { fromDevice: "MacBook", fromDeviceId: "mac" }),
      pendingOf("own long", {
        fromDevice: "MacBook",
        fromDeviceId: "mac",
        change: { kind: "chatInput", body: "x".repeat(MAX_REMOTE_BODY_CHARS + 1) },
      }),
    ]);
    const mac = { id: "mac", name: "MacBook" };
    await expect(
      answerConsent(
        services,
        phone,
        { chat: false, terminal: true },
        { id: "own", answer: "once" },
      ),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("control of the chats"),
    });
    await expect(
      answerConsent(
        services,
        phone,
        { chat: true, terminal: false },
        { id: "term", answer: "once" },
      ),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("control of the terminals"),
    });
    await expect(
      answerConsent(services, mac, { chat: false, terminal: true }, { id: "own", answer: "deny" }),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("control of the chats"),
    });
    await expect(
      answerConsent(services, mac, both, { id: "own long", answer: "once" }),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("too long"),
    });
    expect(answered).toEqual([]);
  });

  test("takes until restart for any prompt, a looser mode's too", async () => {
    const { services, answered } = setup([
      pendingOf("c1", { change: { kind: "chatMode", detail: '"Review" (bypassPermissions)' } }),
    ]);
    await answerConsent(services, phone, both, { id: "c1", answer: "session" });
    expect(answered).toEqual([{ id: "c1", answer: "session", by: "iPhone" }]);
  });

  test("taken down meanwhile: not found", async () => {
    const { services } = setup([pendingOf("c1")]);
    const gone = {
      ...services,
      consents: { list: services.consents.list, answer: async () => false },
    } as unknown as CliServices;
    await expect(
      answerConsent(gone, phone, both, { id: "c1", answer: "once" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  });
});
