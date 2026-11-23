import { afterEach, expect, test } from "bun:test";
import { KeychainGate } from "../../../../../src/main/features/keychain/gate";
import { registerKeychainChannel } from "../../../../../src/main/features/keychain/index";
import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../../../helpers/ipc-pair";

let dispose = () => {};
afterEach(() => {
  dispose();
  resetInMemoryIpc();
});

async function asking() {
  await setupInMemoryRouter();
  let restored = 0;
  const gate = new KeychainGate({
    raw: {
      encrypt: async (text) => Buffer.from(text),
      decrypt: async (data) => data.toString(),
    },
    items: () => ["remote"],
    signature: async () => "new",
    recorded: { get: () => "old", set: () => {} },
    onChange: () => {},
  });
  void gate.whenOpen("remote", async () => {
    restored++;
  });
  dispose = registerKeychainChannel(gate).dispose;
  return { gate, restored: () => restored };
}

test.each([
  ["continue", true, "open", "opening", 1],
  ["later", false, "locked", "locked", 0],
] as const)("the first window asks; %s answers for all", async (_label, open, state, seen, restores) => {
  const { restored } = await asking();
  const first = createIpcPair();
  const second = createIpcPair();
  expect(await first.window.ipc.call("keychain", "claimPrompt", undefined)).toMatchObject({
    ok: true,
    value: { prompt: true, status: { state: "ask", items: ["remote"] } },
  });
  const waiting = second.window.ipc.call("keychain", "claimPrompt", undefined);
  expect(await second.window.ipc.call("keychain", "answer", { open: true })).toMatchObject({
    ok: true,
    value: { state: "ask" },
  });
  expect(await first.window.ipc.call("keychain", "answer", { open })).toMatchObject({
    ok: true,
    value: { state },
  });
  expect(await waiting).toMatchObject({
    ok: true,
    value: { prompt: false, status: { state: seen } },
  });
  expect(restored()).toBe(restores);
});

test("a window closing without answering hands the question on", async () => {
  await asking();
  const first = createIpcPair();
  const second = createIpcPair();
  await first.window.ipc.call("keychain", "claimPrompt", undefined);
  const waiting = second.window.ipc.call("keychain", "claimPrompt", undefined);
  first.sender.destroy();
  expect(await waiting).toMatchObject({ ok: true, value: { prompt: true } });
});

test("the settings' button opens a keychain put off", async () => {
  const { gate, restored } = await asking();
  await gate.decided();
  gate.putOff();
  const window = createIpcPair();
  expect(await window.window.ipc.call("keychain", "open", undefined)).toMatchObject({
    ok: true,
    value: { state: "open" },
  });
  expect(restored()).toBe(1);
});

test("opened elsewhere while a window asks: its question is over, a late answer changes nothing", async () => {
  const { gate, restored } = await asking();
  const first = createIpcPair();
  const second = createIpcPair();
  const third = createIpcPair();
  await first.window.ipc.call("keychain", "claimPrompt", undefined);
  const waiting = third.window.ipc.call("keychain", "claimPrompt", undefined);
  expect(await second.window.ipc.call("keychain", "open", undefined)).toMatchObject({
    ok: true,
    value: { state: "open" },
  });
  expect(await waiting).toMatchObject({ ok: true, value: { prompt: false } });
  expect(await first.window.ipc.call("keychain", "answer", { open: false })).toMatchObject({
    ok: true,
    value: { state: "open" },
  });
  expect(gate.status().state).toBe("open");
  expect(restored()).toBe(1);
});
