import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { UpdateBackend } from "../../../../../src/main/features/updates/installer";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
} from "../../../../helpers/ipc-pair";

mock.module("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  shell: { openExternal: async () => {} },
}));

const { installUpdatesDomain } = await import("../../../../../src/main/features/updates");

beforeEach(resetInMemoryIpc);
afterEach(resetInMemoryIpc);

type Sent = Record<string, unknown> & { kind: string };

async function updater({
  installs = true,
  ignored = null,
}: {
  installs?: boolean;
  ignored?: string | null;
} = {}) {
  await setupInMemoryRouter();
  let published: string | null = "1.1.0";
  const sent: Sent[] = [];
  const calls = { download: 0 };
  let stage: () => void = () => {};
  const backend: UpdateBackend = {
    installAsksForPassword: false,
    check: async () => published,
    download: async () => {
      calls.download += 1;
    },
    onStaged: (listener) => {
      stage = listener;
    },
    onProgress: () => {},
    onError: () => {},
    quitAndInstall: () => {},
  };
  let settings: Record<string, unknown> = { ignoredUpdateVersion: ignored };
  const domain = installUpdatesDomain({
    currentVersion: "1.0.0",
    stateService: {
      getState: () => settings,
      setState: (patch: Record<string, unknown>) => {
        settings = { ...settings, ...patch };
      },
    } as never,
    broadcast: (_channel, event, payload) => {
      if (event === "statusChanged") sent.push(payload as Sent);
    },
    fetchImpl: async () => {
      if (published === null) throw new Error("offline");
      return new Response(`version: ${published}`);
    },
    timerScheduler: { setTimeout: () => 1, clearTimeout: () => {} },
    ...(installs && { updateBackend: backend }),
  });
  const ipc = createIpcPair().window.ipc;
  const settle = () => Bun.sleep(0);
  const status = async () => {
    const result = await ipc.call("updates", "getStatus", undefined);
    return result.ok ? result.value.status : null;
  };
  return {
    domain,
    ipc,
    sent,
    calls,
    settle,
    status,
    publish: (version: string | null) => {
      published = version;
    },
    stage: () => stage(),
  };
}

async function stagedAt(t: Awaited<ReturnType<typeof updater>>) {
  t.domain.checkManual();
  await t.settle();
  await t.ipc.call("updates", "install", undefined);
  await t.settle();
  t.stage();
  expect(await t.status()).toEqual({ kind: "ready", version: "1.1.0" });
  t.sent.length = 0;
}

test("a check while an update waits for the restart downloads a newer one in its place", async () => {
  const t = await updater();
  await stagedAt(t);
  t.publish("1.2.0");

  t.domain.checkManual();
  await t.settle();
  await t.settle();

  expect(t.sent[0]).toMatchObject({ kind: "newer", trigger: "manual", latest: "1.2.0" });
  expect(t.sent.at(-1)).toEqual({ kind: "verifying", version: "1.2.0" });
  t.stage();
  expect(await t.status()).toEqual({ kind: "ready", version: "1.2.0" });
  expect(t.calls.download).toBe(2);
});

test("a check that finds nothing past the staged update keeps it ready", async () => {
  const t = await updater();
  await stagedAt(t);

  t.domain.checkManual();
  await t.settle();
  await t.settle();

  expect(t.sent).toEqual([
    expect.objectContaining({ kind: "newer", trigger: "manual", latest: "1.1.0" }),
  ]);
  expect(await t.status()).toEqual({ kind: "ready", version: "1.1.0" });
  expect(t.calls.download).toBe(1);
});

test("a check while an update is offered moves the offer to a newer version", async () => {
  const t = await updater();
  t.domain.checkManual();
  await t.settle();
  expect(await t.status()).toMatchObject({ kind: "newer", latest: "1.1.0" });

  t.publish("1.2.0");
  t.domain.checkManual();
  await t.settle();
  expect(await t.status()).toMatchObject({ kind: "newer", latest: "1.2.0" });
  expect(t.calls.download).toBe(0);
});

test("a check that fails keeps the offer, and tells why", async () => {
  const t = await updater({ installs: false });
  t.domain.checkManual();
  await t.settle();
  t.publish(null);

  await t.ipc.call("updates", "check", { trigger: "manual" });
  await t.settle();
  expect(t.sent.at(-1)).toMatchObject({ kind: "error", trigger: "manual", reason: "network" });
  expect(await t.status()).toMatchObject({ kind: "newer", latest: "1.1.0", canInstall: false });
});

test("the automatic check keeps a skipped version quiet, and a check finds the one past it", async () => {
  const t = await updater({ ignored: "1.1.0" });
  t.domain.startAutoChecks();
  await t.settle();
  expect(t.sent).toEqual([]);

  t.publish("1.2.0");
  t.domain.checkManual();
  await t.settle();
  expect(t.sent.at(-1)).toMatchObject({ kind: "newer", trigger: "manual", latest: "1.2.0" });
});
