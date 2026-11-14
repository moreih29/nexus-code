/** The consent prompts waiting on the user here, as another device sees and answers them. */
import { describe, expect, test } from "bun:test";
import { RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { CliServices, PendingConsent } from "../../../../../src/main/features/cli/context";
import { answerConsent, remoteConsents } from "../../../../../src/main/features/remote/consents";
import type { CliChange, CliUiOps } from "../../../../../src/shared/cli/ui";
import { MANAGER_WORKSPACE_ID } from "../../../../../src/shared/manager/manager";

type AskArgs = CliUiOps["consent.ask"]["args"];

const pendingOf = (id: string, over: Partial<AskArgs> = {}, at = 1000): PendingConsent => ({
  id,
  at,
  expiresAt: at + 60_000,
  request: {
    fromWorkspaceId: "w1",
    fromTabId: "t1",
    toWorkspaceId: "w2",
    change: { kind: "chatInput", detail: "Review" },
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
  test("who asks, what it would change, and how long it has left", async () => {
    const terminal: CliChange = { kind: "terminalInput", detail: "zsh", body: "rm -rf dist" };
    const { services } = setup([
      pendingOf("c1"),
      pendingOf("c2", { fromWorkspaceId: MANAGER_WORKSPACE_ID, fromTabId: "m1", change: terminal }),
      pendingOf("c3", {
        fromWorkspaceId: "bw",
        fromTabId: "bt",
        fromDevice: "MacBook",
        fromDeviceId: "mac",
        fromName: "Fix build",
        change: { kind: "permissionAllow", detail: "Bash" },
      }),
    ]);
    const listed = await remoteConsents(services, "phone", both, 31_000);
    expect(listed[0]).toEqual({
      id: "c1",
      at: 1000,
      expiresAt: 61_000,
      expiresInMs: 30_000,
      from: { workspaceId: "w1", workspaceName: "app", tabId: "t1", name: "zsh" },
      workspaceId: "w2",
      change: { kind: "chatInput", detail: "Review" },
      eachTime: false,
      answerable: true,
    });
    // The agent manager is in no workspace of the user's.
    expect(listed[1]).toMatchObject({
      from: { manager: true, workspaceId: MANAGER_WORKSPACE_ID, tabId: "m1" },
      change: terminal,
    });
    // Another computer's agent: its workspace and tab name nothing here.
    expect(listed[2]).toMatchObject({
      from: {
        device: { id: "mac", name: "MacBook" },
        workspaceId: "bw",
        tabId: "bt",
        name: "Fix build",
      },
      eachTime: true,
      answerable: true,
    });
    expect(listed[2]?.from).not.toHaveProperty("workspaceName");
  });

  test("a prompt run out says none left, not less than none", async () => {
    const { services } = setup([pendingOf("c1")]);
    expect((await remoteConsents(services, "phone", both, 90_000))[0]?.expiresInMs).toBe(0);
  });

  test("answerable only with the controls it needs, and never by the device whose agent asks", async () => {
    const { services } = setup([
      pendingOf("chat"),
      pendingOf("term", { change: { kind: "tabClose", detail: "zsh", terminal: true } }),
      pendingOf("own", { fromDevice: "MacBook", fromDeviceId: "mac" }),
    ]);
    const answerable = async (device: string, controls: { chat: boolean; terminal: boolean }) =>
      (await remoteConsents(services, device, controls)).map((c) => c.answerable);
    expect(await answerable("phone", both)).toEqual([true, true, true]);
    expect(await answerable("phone", { chat: true, terminal: false })).toEqual([true, false, true]);
    expect(await answerable("phone", { chat: false, terminal: true })).toEqual([
      false,
      false,
      false,
    ]);
    expect(await answerable("mac", both)).toEqual([true, true, false]);
  });

  test("none waiting: nothing is looked up", async () => {
    const services = {
      consents: { list: () => [] },
      ui: async () => {
        throw new Error("asked");
      },
    } as unknown as CliServices;
    expect(await remoteConsents(services, "phone", both)).toEqual([]);
  });
});

describe("answering one from another device", () => {
  test("answers it as the user would, saying from which device", async () => {
    const { services, answered } = setup([pendingOf("c1")]);
    expect(await answerConsent(services, phone, both, { id: "c1", answer: "session" })).toEqual({});
    expect(answered).toEqual([{ id: "c1", answer: "session", by: "iPhone" }]);
  });

  test("one answered or run out since is not found", async () => {
    const { services } = setup([]);
    await expect(
      answerConsent(services, phone, both, { id: "c1", answer: "once" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  });

  test("refused without the controls it needs, or by the asking agent's device", async () => {
    const { services, answered } = setup([
      pendingOf("term", { change: { kind: "terminalNew" } }),
      pendingOf("own", { fromDevice: "MacBook", fromDeviceId: "mac" }),
    ]);
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
      answerConsent(services, { id: "mac", name: "MacBook" }, both, { id: "own", answer: "deny" }),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("own agent"),
    });
    expect(answered).toEqual([]);
  });

  test("what is asked each time takes no answer for a while", async () => {
    const { services, answered } = setup([
      pendingOf("c1", { change: { kind: "chatMode", detail: '"Review" (bypassPermissions)' } }),
    ]);
    await expect(
      answerConsent(services, phone, both, { id: "c1", answer: "session" }),
    ).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("each time"),
    });
    await answerConsent(services, phone, both, { id: "c1", answer: "deny" });
    expect(answered).toEqual([{ id: "c1", answer: "deny", by: "iPhone" }]);
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
