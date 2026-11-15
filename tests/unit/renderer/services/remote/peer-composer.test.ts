/** This app's own composer driving another computer's chat, through the room. */
import { describe, expect, test } from "bun:test";
import type { ChatCommand, ChatSettings } from "../../../../../packages/remote-protocol/src";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  commandInfosOf,
  commandOf,
  modelsOf,
  peerComposerController,
  withSettings,
} from "../../../../../src/renderer/services/remote/peer-composer";

const ref = { deviceId: "d1", workspaceId: "w1", tabId: "t1" };

const settings: ChatSettings = {
  agent: "claude",
  model: "opus",
  effort: "high",
  permissionMode: "default",
  options: {
    models: [
      { id: "default", label: "Default" },
      { id: "opus", label: "Opus" },
    ],
    efforts: ["low", "high"],
    modes: [{ id: "default", label: "Ask before edits" }],
  },
};

/** A PNG's base64 whose header says 2 by 2. */
function png(): string {
  const b = Buffer.alloc(32, 1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(2, 20);
  return b.toString("base64");
}

function recording(fail?: string) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const call = (async (_channel: string, method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (fail === method) return { ok: false, kind: "unavailable", message: "not now" };
    if (method === "peerChatAttach")
      return { ok: true, value: { attachmentId: `a${calls.length}` } };
    if (method === "peerChatConfigure") return { ok: true, value: { ...settings, ...args } };
    return { ok: true, value: {} };
  }) as never;
  return { calls, call };
}

function controller(call: never, now: ChatSettings | null = settings) {
  const told: ChatSettings[] = [];
  const made = peerComposerController({
    ref,
    agent: "claude",
    settings: () => now,
    onSettings: (s) => told.push(s),
    filesRefused: "images only",
    call,
  });
  return { made, told };
}

describe("the composer of another computer's chat", () => {
  test("sends a message there, its images given ahead", async () => {
    const { calls, call } = recording();
    const { made } = controller(call);
    await made.send("look", [{ mediaType: "image/png", data: png() }]);
    expect(calls.map((c) => c.method)).toEqual(["peerChatAttach", "peerChatSend"]);
    expect(calls[0]?.args).toMatchObject({ ...ref, mediaType: "image/png", data: png() });
    expect(calls[1]?.args).toEqual({ ...ref, text: "look", attachments: ["a1"] });
  });

  test("during a turn sends at once: the device keeps it till the turn reads it", async () => {
    const { calls, call } = recording();
    const { made } = controller(call);
    made.enqueue("next", []);
    await Promise.resolve();
    expect(calls).toEqual([{ method: "peerChatSend", args: { ...ref, text: "next" } }]);
    expect(made.removeQueued("q1")).toBeUndefined();
    expect(made.withdraw).toBeUndefined();
    expect(made.sendNow).toBeUndefined();
  });

  test("a refusal there is an error the composer tells", async () => {
    const { call } = recording("peerChatSend");
    await expect(controller(call).made.send("hi")).rejects.toThrow("not now");
    await expect(controller(recording().call).made.attach("a.pdf", "")).rejects.toThrow(
      "images only",
    );
  });

  test("a message sent during a turn that did not go is told, the box being empty already", async () => {
    const { call } = recording("peerChatSend");
    const errors: string[] = [];
    const made = peerComposerController({
      ref,
      agent: "claude",
      settings: () => settings,
      onSettings: () => {},
      filesRefused: "images only",
      onError: (message) => errors.push(message),
      call,
    });
    made.enqueue("next", []);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(["not now"]);
  });

  test("a chip a bare command opened is dropped here, as the store drops a local chat's", () => {
    const opened: number[] = [];
    const made = peerComposerController({
      ref,
      agent: "claude",
      settings: () => settings,
      onSettings: () => {},
      filesRefused: "images only",
      onRevealed: (seq) => opened.push(seq),
      call: recording().call,
    });
    made.revealed?.(3);
    expect(opened).toEqual([3]);
  });

  test("its chips set what the chat runs with there, and hear what it runs with after", async () => {
    const { calls, call } = recording();
    const { made, told } = controller(call);
    await made.setModel("default");
    await made.setEffort("low");
    await made.setPermissionMode("plan");
    expect(calls.map((c) => c.args)).toEqual([
      { ...ref, model: "default" },
      { ...ref, effort: "low" },
      { ...ref, permissionMode: "plan" },
    ]);
    expect(told.map((s) => [s.model, s.effort, s.permissionMode])).toEqual([
      ["default", "high", "default"],
      ["opus", "low", "default"],
      ["opus", "high", "plan"],
    ]);
  });

  test("offers effort only for a model that takes it, and nothing only a chat here has", () => {
    const { call } = recording();
    expect(controller(call).made.supports("apply_flag_settings")).toBe(true);
    const none = { ...settings, options: { ...settings.options, efforts: [] } };
    expect(controller(call, none).made.supports("apply_flag_settings")).toBe(false);
    expect(controller(call, null).made.supports("apply_flag_settings")).toBe(false);
    expect(controller(call).made.supports("cancel_async_message")).toBe(false);
    expect(controller(call).made.supports("file_suggestions")).toBe(false);
  });

  test("its model chip lists the chat's models, the one it runs knowing its efforts", () => {
    expect(modelsOf(settings)).toEqual([
      { value: "default", displayName: "Default" },
      { value: "opus", displayName: "Opus", supportedEffortLevels: ["low", "high"] },
    ]);
    const model = withSettings({ ...emptyModel(), model: "claude-opus-5-5" }, settings);
    expect(model).toMatchObject({
      model: "opus",
      chosenModel: "opus",
      effort: "high",
      permissionMode: "default",
    });
    expect(model.init?.models).toHaveLength(2);
    const before = emptyModel();
    expect(withSettings(before, null)).toBe(before);
  });

  test("a typed command runs there, sets a chip, or goes as a message", () => {
    const commands: ChatCommand[] = [
      { name: "rename", description: "Rename", runs: "command", args: "<title>" },
      { name: "model", description: "Model", runs: "settings", sets: "model" },
      { name: "review", description: "Review", runs: "send" },
    ];
    expect(commandOf(commands, "/rename  Notes ")).toEqual({
      kind: "command",
      name: "rename",
      args: "Notes",
    });
    expect(commandOf(commands, "/model opus")).toEqual({
      kind: "set",
      sets: "model",
      value: "opus",
    });
    expect(commandOf(commands, "/model")).toEqual({ kind: "set", sets: "model" });
    expect(commandOf(commands, "/review")).toBeNull();
    expect(commandOf(commands, "/unknown")).toBeNull();
    expect(commandOf(commands, "hello")).toBeNull();
    expect(commandInfosOf(commands)[0]).toEqual({
      name: "rename",
      description: "Rename",
      argumentHint: "<title>",
    });
  });
});
