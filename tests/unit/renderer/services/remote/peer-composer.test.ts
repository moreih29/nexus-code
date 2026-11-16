/** This app's own composer driving another computer's chat, through the room. */
import { describe, expect, test } from "bun:test";
import type { ChatCommand, ChatSettings } from "../../../../../packages/remote-protocol/src";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  commandInfosOf,
  commandOf,
  heldQueueOf,
  mentionOf,
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

  test("before its device says what it lets do: ⌘⇧↩ is held there, ⌘↩ goes as ↩ does", async () => {
    const { calls, call } = recording();
    const { made } = controller(call);
    made.enqueue("next", []);
    await Promise.resolve();
    await made.sendNow?.("now");
    await made.readHeldNow?.();
    expect(calls).toEqual([
      { method: "peerChatSend", args: { ...ref, text: "next", when: "after" } },
      { method: "peerChatSend", args: { ...ref, text: "now" } },
    ]);
    expect(made.supports("cancel_async_message")).toBe(false);
  });

  test("a message goes when its keys say, held there, taken back whole", async () => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const call = (async (_channel: string, method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "peerChatUnqueue") return { ok: true, value: { text: "the whole text" } };
      if (method === "peerChatWithdraw") return { ok: true, value: { withdrawn: true } };
      return { ok: true, value: {} };
    }) as never;
    const made = peerComposerController({
      ref,
      agent: "claude",
      settings: () => settings,
      onSettings: () => {},
      filesRefused: "images only",
      can: () => ({
        rewind: true,
        fork: true,
        background: true,
        now: true,
        withdraw: true,
        hurry: true,
      }),
      call,
    });
    made.enqueue("later", []);
    await Promise.resolve();
    await made.sendNow?.("now");
    await made.readHeldNow?.();
    expect(await made.withdraw?.("u3")).toBe(true);
    expect(await made.takeBackQueued?.("q1")).toEqual({
      id: "q1",
      text: "the whole text",
      images: [],
    });
    expect(made.removeQueued("q2")).toBeUndefined();
    expect(made.supports("cancel_async_message")).toBe(true);
    expect(calls).toEqual([
      { method: "peerChatSend", args: { ...ref, text: "later", when: "after" } },
      { method: "peerChatSend", args: { ...ref, text: "now", when: "now" } },
      { method: "peerChatHurry", args: ref },
      { method: "peerChatWithdraw", args: { ...ref, itemKey: "u3" } },
      { method: "peerChatUnqueue", args: { ...ref, id: "q1" } },
      { method: "peerChatUnqueue", args: { ...ref, id: "q2" } },
    ]);
  });

  test("a Codex chat's ↩ goes into the turn: no ⌘↩ of its own, nothing to withdraw", () => {
    const made = peerComposerController({
      ref,
      agent: "codex",
      settings: () => settings,
      onSettings: () => {},
      filesRefused: "images only",
      call: recording().call,
    });
    expect(made.sendNow).toBeUndefined();
    expect(made.withdraw).toBeUndefined();
    expect(made.readHeldNow).toBeUndefined();
  });

  test("the held messages above the box: one cut short ends in an ellipsis", () => {
    expect(
      heldQueueOf([
        { id: "q1", text: "short" },
        { id: "q2", text: "long", truncated: true, images: 2 },
      ]),
    ).toEqual([
      { id: "q1", text: "short", images: [] },
      { id: "q2", text: "long…", images: [] },
    ]);
    expect(heldQueueOf(undefined)).toEqual([]);
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
  });

  test("an @ lists what the chat's agent suggests there", async () => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const call = (async (_channel: string, method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      return { ok: true, value: { paths: ["src/", "src/app.ts"] } };
    }) as never;
    const { made } = controller(call);
    expect(made.supports("file_suggestions")).toBe(true);
    expect(await made.fileSuggestions("app")).toEqual(["src/", "src/app.ts"]);
    expect(await made.fileSuggestions("")).toEqual(["src/", "src/app.ts"]);
    expect(calls).toEqual([
      { method: "peerChatFileSuggestions", args: { ...ref, query: "app" } },
      { method: "peerChatFileSuggestions", args: { ...ref, query: "" } },
    ]);
  });

  test("from a device before 0.13.0, the workspace's files by name, from the chat's folder", async () => {
    const calls: string[] = [];
    const call = (async (_channel: string, method: string, args: Record<string, unknown>) => {
      calls.push(method);
      if (method === "peerChatFileSuggestions")
        return { ok: false, kind: "unsupported", message: "no method" };
      expect(args).toEqual({ deviceId: "d1", workspaceId: "w1", query: "app", limit: 50 });
      return { ok: true, value: { files: ["pkg/src/app.ts", "docs/app.md"] } };
    }) as never;
    const made = peerComposerController({
      ref,
      agent: "claude",
      settings: () => settings,
      onSettings: () => {},
      filesRefused: "images only",
      folders: () => ({ root: "/home/me/repo", cwd: "/home/me/repo/pkg" }),
      call,
    });
    expect(await made.fileSuggestions("app")).toEqual(["src/app.ts", "/home/me/repo/docs/app.md"]);
    // Asked once: the next @ goes to files.find straight; an empty one lists nothing.
    expect(await made.fileSuggestions("app")).toHaveLength(2);
    expect(await made.fileSuggestions(" ")).toEqual([]);
    expect(calls).toEqual(["peerChatFileSuggestions", "peerFilesFind", "peerFilesFind"]);
  });

  test("a refused @ lists nothing", async () => {
    const { call } = recording("peerChatFileSuggestions");
    expect(await controller(call).made.fileSuggestions("app")).toEqual([]);
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

describe("an @ from a device before 0.13.0", () => {
  const unix = { root: "/home/me/repo", cwd: "/home/me/repo" };
  test("names a file of the chat's folder as the workspace's search found it", () => {
    expect(mentionOf("src/app.ts", unix)).toBe("src/app.ts");
    expect(mentionOf("src/app.ts", { root: "/home/me/repo/", cwd: "/home/me/repo" })).toBe(
      "src/app.ts",
    );
  });

  test("from a chat in a folder under the workspace's, relative to it, and absolute outside it", () => {
    const sub = { root: "/home/me/repo", cwd: "/home/me/repo/pkg" };
    expect(mentionOf("pkg/a.ts", sub)).toBe("a.ts");
    expect(mentionOf("other/a.ts", sub)).toBe("/home/me/repo/other/a.ts");
    // A folder whose name only starts with the workspace's is not in it.
    expect(mentionOf("a.ts", { root: "/home/me/repo", cwd: "/home/me/repo2" })).toBe(
      "/home/me/repo/a.ts",
    );
  });

  test("on Windows, with its separators and its case", () => {
    const win = { root: "C:\\Users\\me\\repo", cwd: "c:\\users\\me\\repo\\pkg" };
    expect(mentionOf("pkg/src/a.ts", win)).toBe("src/a.ts");
    expect(mentionOf("docs/a.md", win)).toBe("C:\\Users\\me\\repo\\docs\\a.md");
  });
});
