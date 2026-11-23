import { describe, expect, test } from "bun:test";
import {
  MAX_TRANSCRIPT_LINES,
  NOTE_PAGES_SCHEMA,
  RPC_METHODS,
  type RpcParams,
} from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice, CliServices } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { noteTranscript, readNote } from "../../../../src/main/features/remote/notes";
import type { TranscriptFile } from "../../../../src/shared/notes/transcript";
import { APP, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const NOW = 1_700_000_000_000;
const SELF = "3f2a91c0-0000-4000-8000-000000000001";
const MINI = "9b1e44d2-0000-4000-8000-000000000002";
const SITE = "dddddddd-0000-4000-8000-0000000000aa";

function recording(id: string, count: number) {
  return {
    id,
    startedAt: NOW,
    language: "en",
    takes: [],
    speakers: { s1: "Ada" },
    speakerNumbers: { s1: "1", s2: "2" },
    lines: Array.from({ length: count }, (_, i) => ({
      speaker: i % 3 === 2 ? "s2" : "s1",
      startMs: i * 10_000,
      endMs: i * 10_000 + 900,
      text: `line ${i}`,
    })),
    participantCount: 2,
  };
}

function hostServices(file: TranscriptFile): CliServices {
  const note = {
    id: "nabcdef1",
    title: "Standup",
    updatedAt: 1000,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }],
    },
    ...(file.recordings.length
      ? { recording: { recordings: file.recordings.length, ms: 1, people: 2 } }
      : {}),
  };
  return {
    listWorkspaces: () => [{ id: SITE, name: "site", rootPath: "/Users/me/site" }],
    notes: {
      list: async () => [note],
      read: async () => note,
      transcript: async () => file,
    },
  } as unknown as CliServices;
}

function olderAnswer(method: string, result: unknown): unknown {
  if (method === "notes.read") {
    const { recordings: _recordings, ...rest } = result as Record<string, unknown>;
    return rest;
  }
  if (method === "notes.transcript") {
    const answer = result as { recordings: Record<string, unknown>[] };
    return {
      ...answer,
      recordings: answer.recordings.map(({ start: _start, total: _total, ...rest }) => rest),
    };
  }
  return result;
}

function withHost(file: TranscriptFile, schema: string): FakeApp {
  const app = fakeApp(NOW);
  const device = (over: Partial<CliDevice> & Pick<CliDevice, "id" | "name">): CliDevice => ({
    platform: "macos",
    self: false,
    online: true,
    serves: [],
    ...over,
  });
  app.peers.devices = [
    device({ id: SELF, name: "MacBook", self: true }),
    device({
      id: MINI,
      name: "Mac mini",
      serves: ["sessions", "chat.read", "agents", "agents.cli", "notes"],
      schema,
    }),
  ];
  const services = hostServices(file);
  const older = schema !== NOTE_PAGES_SCHEMA;
  app.peers.answer = async (_d, method, params) => {
    if (method === "sessions.list") {
      return { workspaces: [{ id: SITE, name: "site", path: "/Users/me/site" }], sessions: [] };
    }
    if (method !== "notes.read" && method !== "notes.transcript") {
      throw new Error(`no answer for ${method}`);
    }
    const parsed = RPC_METHODS[method].params.parse(params) as Record<string, unknown>;
    if (older) {
      delete parsed.withoutTranscript;
      delete parsed.start;
      delete parsed.limit;
    }
    const result =
      method === "notes.read"
        ? await readNote(services, parsed as RpcParams<"notes.read">)
        : await noteTranscript(services, parsed as RpcParams<"notes.transcript">);
    return older ? olderAnswer(method, result) : result;
  };
  return app;
}

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }, {}));
}

const file: TranscriptFile = {
  version: 1,
  recordings: [
    recording("rabcdef1234", 2 * MAX_TRANSCRIPT_LINES + 500),
    recording("rabcdef5678", 3),
  ],
};

const COMMANDS = [
  ["note", "read", "Standup"],
  ["note", "read", "Standup", "--transcript"],
  ["note", "read", "Standup", "--json"],
  ["note", "read", "Standup", "--transcript", "--json"],
  ["note", "transcript", "Standup"],
  ["note", "transcript", "Standup", "--json"],
  ["note", "transcript", "Standup", "--recording", "rabcdef5"],
  ["note", "transcript", "Standup", "--recording", "rabcdef1234", "--json"],
];

describe("note read and note transcript --device", () => {
  test.each(
    COMMANDS,
  )("%s %s %s %s %s: a 0.31.0 host in pages prints what an older host does at once", async (...command) => {
    const argv = [...command, "--workspace", "site", "--device", MINI];
    const older = withHost(file, "0.30.0");
    const newer = withHost(file, NOTE_PAGES_SCHEMA);
    const before = await nexus(older, argv);
    const after = await nexus(newer, argv);
    expect(before.exitCode).toBe(0);
    expect(after).toEqual(before);
    expect(older.peers.requests.filter((r) => r.method.startsWith("notes."))).toHaveLength(1);
  });

  test("the output keeps its form", async () => {
    const app = withHost(file, NOTE_PAGES_SCHEMA);
    const read = await nexus(app, [
      "note",
      "read",
      "Standup",
      "--workspace",
      "site",
      "--device",
      MINI,
    ]);
    expect(read.stdout).toStartWith("# Standup\n\nBody text\n\n---\n\n# Transcript: Standup\n");
    expect(read.stdout).toContain(
      "[0:00] Ada: line 0\n[0:10] Ada: line 1\n[0:20] Speaker 2: line 2\n",
    );
    const json = JSON.parse(
      (
        await nexus(app, [
          "note",
          "read",
          "Standup",
          "--workspace",
          "site",
          "--device",
          MINI,
          "--json",
        ])
      ).stdout,
    );
    expect(Object.keys(json)).toEqual([
      "device",
      "id",
      "title",
      "updatedAt",
      "markdown",
      "transcript",
    ]);
    const lines = await nexus(app, [
      "note",
      "transcript",
      "Standup",
      "--recording",
      "rabcdef5678",
      "--workspace",
      "site",
      "--device",
      MINI,
      "--json",
    ]);
    const parsed = JSON.parse(lines.stdout);
    expect(Object.keys(parsed.recordings[0])).toEqual(["id", "startedAt", "participants", "lines"]);
    expect(parsed.recordings[0].lines[0]).toEqual({
      id: "0:900:1",
      startMs: 0,
      endMs: 900,
      speaker: "s1",
      speakerLabel: "Speaker 1",
      speakerName: "Ada",
      text: "line 0",
    });
  });

  test("a 0.31.0 host is asked for the body without the transcript, then each recording a page at a time", async () => {
    const app = withHost(file, NOTE_PAGES_SCHEMA);
    await nexus(app, ["note", "read", "Standup", "--workspace", "site", "--device", MINI]);
    const notes = app.peers.requests.filter((r) => r.method.startsWith("notes."));
    expect(notes[0]).toMatchObject({
      method: "notes.read",
      params: { workspaceId: SITE, note: "Standup", withoutTranscript: true },
    });
    expect(notes.slice(1).map((r) => r.params)).toEqual([
      expect.objectContaining({ note: "nabcdef1", recording: "rabcdef1234", start: 0 }),
      expect.objectContaining({ recording: "rabcdef1234", start: MAX_TRANSCRIPT_LINES }),
      expect.objectContaining({ recording: "rabcdef1234", start: 2 * MAX_TRANSCRIPT_LINES }),
      expect.objectContaining({ recording: "rabcdef5678", start: 0 }),
    ]);
  });
});
