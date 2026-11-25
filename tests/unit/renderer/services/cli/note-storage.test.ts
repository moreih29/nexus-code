import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { runCli } from "../../../../../src/main/features/cli/registry";
import type { CliNoteStorageEntry, CliUiOps } from "../../../../../src/shared/cli/ui";
import { contextFor, type FakeApp, fakeApp } from "../../../main/cli/fake-services";

const bytes = { text: 2048, sketches: 0, files: 1024, images: 0, recordings: 0 };

const SITE: CliNoteStorageEntry = {
  location: { key: "local:/w/site", kind: "local", path: "/w/site", label: "site" },
  notes: 3,
  bytes,
  updatedAt: 1,
  workspaceIds: ["ws-site"],
};
const SITE_ON_BOX: CliNoteStorageEntry = {
  location: {
    key: "ssh:box:/srv/site",
    kind: "ssh",
    path: "/srv/site",
    host: "box",
    label: "site",
  },
  notes: 1,
  bytes: { ...bytes, files: 0 },
  updatedAt: 2,
  workspaceIds: [],
};
const OLD: CliNoteStorageEntry = {
  location: { key: "local:/w/old", kind: "local", path: "/w/old", label: "old" },
  notes: 1,
  bytes: { ...bytes, files: 0, text: 100 },
  updatedAt: 3,
  workspaceIds: [],
};

let entries: CliNoteStorageEntry[] = [];
const removed: unknown[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel === "notes" && method === "storage") {
      return Promise.resolve({ ok: true, value: structuredClone(entries) });
    }
    if (channel === "notes" && method === "removeLocation") removed.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { noteHandlers } = await import("../../../../../src/renderer/services/cli/note-actions");
const remove = noteHandlers["note.storage.remove"];

function app(): FakeApp {
  const made = fakeApp();
  made.uiAnswers.set("note.storage.remove", (args: CliUiOps["note.storage.remove"]["args"]) =>
    remove(args),
  );
  return made;
}

const nexus = (made: FakeApp, argv: string[]) => runCli(CLI_COMMANDS, contextFor(made, argv));

beforeEach(() => {
  entries = [SITE, SITE_ON_BOX, OLD];
  removed.length = 0;
});

describe("note storage remove", () => {
  it("names the location, its notes and the workspaces using it, and removes once allowed", async () => {
    const made = app();
    const denied = await nexus(made, ["note", "storage", "remove", "/w/site"]);
    expect(denied.stderr).toBe("nexus: the user did not allow it\n");
    expect(removed).toEqual([]);
    expect(made.asked.at(-1)?.change).toEqual({
      kind: "noteStorageRemove",
      detail: "site",
      settingsEdit: {
        lines: [
          { field: "location", to: "/w/site" },
          { field: "notes", count: 3, size: "3.0 KB" },
          { field: "workspaces", count: 1 },
        ],
      },
      eachTime: true,
    });

    made.answers.push("once");
    const done = await nexus(made, ["note", "storage", "remove", "old"]);
    expect(done.stdout).toBe('Moved 1 note (100 B) of "old" to the Trash.\n');
    expect(made.asked.at(-1)?.change.settingsEdit?.lines).toEqual([
      { field: "location", to: "/w/old" },
      { field: "notes", count: 1, size: "100 B" },
    ]);
    expect(removed).toEqual([{ key: "local:/w/old" }]);
  });

  it("refuses an unknown or ambiguous location and --device before asking", async () => {
    const made = app();
    const tries = [
      [["gone"], 'no notes are kept for "gone"'],
      [["site"], 'more than one location is named "site"; give its path: /w/site, box:/srv/site'],
      [["old", "--device", "Mac mini"], "--device is not taken here"],
    ] as const;
    for (const [argv, message] of tries) {
      const result = await nexus(made, ["note", "storage", "remove", ...argv]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
    expect(made.asked).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("removes nothing when the location's notes change while the user is asked", async () => {
    const made = app();
    const ask = made.services.askUser;
    made.services = {
      ...made.services,
      askUser: async (request, signal) => {
        entries = entries.map((entry) =>
          entry.location.key === OLD.location.key
            ? { ...entry, notes: entry.notes + 1, updatedAt: entry.updatedAt + 1 }
            : entry,
        );
        return ask(request, signal);
      },
    };
    made.answers.push("once");
    const result = await nexus(made, ["note", "storage", "remove", "box:/srv/site"]);
    expect(result.stderr).toBe("");
    expect(removed).toEqual([{ key: "ssh:box:/srv/site" }]);
    made.answers.push("once");
    const changed = await nexus(made, ["note", "storage", "remove", "local:/w/old"]);
    expect(changed.stderr).toContain(
      "the notes there changed while waiting for the user's approval",
    );
    expect(removed).toEqual([{ key: "ssh:box:/srv/site" }]);
  });

  it("finds a Windows location given in the forms Windows shells and Explorer write", async () => {
    const WIN: CliNoteStorageEntry = {
      location: {
        key: "local:C:/tmp/QA 노트",
        kind: "local",
        path: "C:/tmp/QA 노트",
        label: "QA 노트",
      },
      notes: 1,
      bytes,
      updatedAt: 4,
      workspaceIds: [],
    };
    const WIN_ON_BOX: CliNoteStorageEntry = {
      location: { ...WIN.location, key: "ssh:pc:C:/tmp/QA 노트", kind: "ssh", host: "pc" },
      notes: 1,
      bytes,
      updatedAt: 5,
      workspaceIds: [],
    };
    entries = [WIN, WIN_ON_BOX, OLD];
    for (const location of [
      "C:\\tmp\\QA 노트",
      "c:/tmp/qa 노트",
      "C:/tmp/QA 노트/",
      "C:\\tmp\\\\QA 노트\\",
      '"C:\\tmp\\QA 노트"',
    ]) {
      expect(await remove({ location })).toMatchObject({ entry: WIN, removed: false });
    }
    await expect(remove({ location: "C:\\tmp\\other" })).rejects.toThrow("no notes are kept");
    await expect(remove({ location: "/W/OLD" })).rejects.toThrow("no notes are kept");
  });

  it("only looks without approval, in the renderer", async () => {
    const plan = await remove({ location: "old" });
    expect(plan).toMatchObject({ entry: OLD, removed: false });
    await expect(remove({ location: "old", approved: true, before: "{}" })).rejects.toThrow(
      "the notes there changed",
    );
    expect(removed).toEqual([]);
  });
});
