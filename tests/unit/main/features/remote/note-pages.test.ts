import { describe, expect, mock, test } from "bun:test";
import {
  MAX_TRANSCRIPT_LINES,
  NOTE_PAGES_SCHEMA,
  RPC_METHODS,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { listNotes, noteTranscript, readNote } from "../../../../../src/main/features/remote/notes";
import { readWholePeerNote } from "../../../../../src/main/features/remote/peer-notes";
import { fitsAsResult } from "../../../../../src/main/features/remote/serving/common";
import {
  type TranscriptFile,
  type TranscriptRecording,
  transcriptMarkdown,
} from "../../../../../src/shared/notes/transcript";

function recording(id: string, count: number, text = (i: number) => `line ${i}`) {
  return {
    id,
    startedAt: 1_700_000_000_000,
    language: "en",
    takes: [],
    speakers: { s1: "Ada" },
    speakerNumbers: { s1: "1", s2: "2" },
    lines: Array.from({ length: count }, (_, i) => ({
      speaker: i % 3 === 2 ? "s2" : "s1",
      startMs: i * 10_000,
      endMs: i * 10_000 + 900,
      text: text(i),
    })),
    participantCount: 2,
  } satisfies TranscriptRecording;
}

const doc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }],
};

function servicesWith(file: TranscriptFile, withRecording = true): CliServices {
  const note = {
    id: "nabcdef1",
    title: "Standup",
    updatedAt: 1000,
    doc,
    ...(withRecording
      ? { recording: { recordings: file.recordings.length, ms: 1, people: 2 } }
      : {}),
  };
  return {
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    notes: {
      list: async () => [note],
      read: async () => note,
      transcript: async () => file,
    },
  } as unknown as CliServices;
}

const small: TranscriptFile = {
  version: 1,
  recordings: [recording("rabcdef1234", 5), recording("rabcdef5678", 2)],
};

const huge: TranscriptFile = {
  version: 1,
  recordings: [recording("rabcdef1234", 4000, (i) => `${i} ${"word ".repeat(300)}`)],
};

describe("notes.read", () => {
  test("tells each recording's id and size, with or without the transcript", async () => {
    const s = servicesWith(small);
    const whole = await readNote(s, { workspaceId: "w1", note: "nabcdef1" });
    const body = await readNote(s, {
      workspaceId: "w1",
      note: "nabcdef1",
      withoutTranscript: true,
    });
    expect(whole.transcript).toBe(transcriptMarkdown(small, "Standup"));
    expect(body.transcript).toBe("");
    expect(body.markdown).toBe(whole.markdown);
    expect(body.markdown).toContain("Body text");
    expect(body.recordings).toEqual([
      { id: "rabcdef1234", startedAt: 1_700_000_000_000, ms: 40_900, lines: 5, participants: 2 },
      { id: "rabcdef5678", startedAt: 1_700_000_000_000, ms: 10_900, lines: 2, participants: 2 },
    ]);
    expect(whole.recordings).toEqual(body.recordings);
    expect(RPC_METHODS["notes.read"].result.parse(body)).toEqual(body);
  });

  test("a note without recordings lists none", async () => {
    const s = servicesWith({ version: 1, recordings: [] }, false);
    expect(
      await readNote(s, { workspaceId: "w1", note: "nabcdef1", withoutTranscript: true }),
    ).toMatchObject({ transcript: "", recordings: [] });
  });

  test("a transcript too large for one answer still lets the body through without it", async () => {
    const s = servicesWith(huge);
    await expect(readNote(s, { workspaceId: "w1", note: "nabcdef1" })).rejects.toMatchObject({
      code: RpcErrorCode.Unavailable,
    });
    expect(
      await readNote(s, { workspaceId: "w1", note: "nabcdef1", withoutTranscript: true }),
    ).toMatchObject({ transcript: "", recordings: [{ id: "rabcdef1234", lines: 4000 }] });
  });

  test("transcriptOnly and withoutTranscript together are refused", async () => {
    await expect(
      readNote(servicesWith(small), {
        workspaceId: "w1",
        note: "nabcdef1",
        transcriptOnly: true,
        withoutTranscript: true,
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  });
});

describe("notes.transcript", () => {
  const ask = (
    file: TranscriptFile,
    params: Omit<RpcParams<"notes.transcript">, "workspaceId" | "note">,
  ) => noteTranscript(servicesWith(file), { workspaceId: "w1", note: "nabcdef1", ...params });

  test("without start or limit, every line of every recording, with start and total", async () => {
    const result = await ask(small, {});
    expect(
      result.recordings.map(({ id, start, total, lines }) => [id, start, total, lines.length]),
    ).toEqual([
      ["rabcdef1234", 0, 5, 5],
      ["rabcdef5678", 0, 2, 2],
    ]);
  });

  test("a page of one recording from start, at most limit lines, the ids as in the whole", async () => {
    const whole = await ask(small, { recording: "rabcdef1234" });
    const page = await ask(small, { recording: "rabcdef1234", start: 1, limit: 2 });
    expect(page.recordings).toHaveLength(1);
    expect(page.recordings[0]).toMatchObject({ id: "rabcdef1234", start: 1, total: 5 });
    expect(page.recordings[0]?.lines).toEqual(whole.recordings[0]?.lines.slice(1, 3));
    const past = await ask(small, { recording: "rabcdef1234", start: 9 });
    expect(past.recordings[0]).toMatchObject({ start: 5, total: 5, lines: [] });
  });

  test("start or limit without a recording is refused", async () => {
    await expect(ask(small, { start: 0 })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
    await expect(ask(small, { limit: 10 })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
  });

  test("a long transcript comes in pages that each fit in a frame", async () => {
    await expect(ask(huge, {})).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
    const first = await ask(huge, { recording: "rabcdef1234", limit: MAX_TRANSCRIPT_LINES });
    expect(first.recordings[0]?.lines.length).toBeLessThan(MAX_TRANSCRIPT_LINES);
    expect(first.recordings[0]?.lines.length).toBeGreaterThan(0);
    const texts: string[] = [];
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(100);
      const page = await ask(huge, { recording: "rabcdef1234", start: texts.length });
      expect(fitsAsResult(page)).toBe(true);
      const got = page.recordings[0];
      expect(got?.start).toBe(texts.length);
      expect(got?.lines.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_LINES);
      texts.push(...(got?.lines.map((line) => line.text) ?? []));
      if (texts.length >= (got?.total ?? 0)) break;
    }
    expect(texts).toEqual(huge.recordings[0]?.lines.map((line) => line.text));
  });

  test("limit is bounded by the protocol", () => {
    const params = RPC_METHODS["notes.transcript"].params;
    const base = { workspaceId: "w1", note: "n", recording: "r" };
    expect(params.safeParse({ ...base, limit: MAX_TRANSCRIPT_LINES }).success).toBe(true);
    expect(params.safeParse({ ...base, limit: MAX_TRANSCRIPT_LINES + 1 }).success).toBe(false);
    expect(params.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(params.safeParse({ ...base, start: -1 }).success).toBe(false);
  });
});

test("notes.list tells how many recordings a note has", async () => {
  const listed = await listNotes(
    {
      list: async () => [
        { id: "n1", title: "a", updatedAt: 2, recording: { recordings: 3 } },
        { id: "n2", title: "b", updatedAt: 1 },
      ],
      attach: async () => ({ src: "" }),
      recording: () => undefined,
    },
    { workspaceId: "w1" },
  );
  expect(listed.notes.map((note) => note.recordings)).toEqual([3, 0]);
});

describe("another computer's note on the desktop", () => {
  function room(file: TranscriptFile, schema: string | undefined) {
    const s = servicesWith(file);
    const request = mock(async (_to: string, method: RpcMethod, params: object) => {
      const parsed = RPC_METHODS[method].params.parse(params) as never;
      if (method === "notes.read") return readNote(s, parsed);
      if (method === "notes.transcript") return noteTranscript(s, parsed);
      throw new Error(method);
    });
    const state = () => ({
      status: "online" as const,
      peers: [{ id: "d2", name: "mini", platform: "darwin", online: true, schema }],
    });
    return { room: { request: request as never, state }, request };
  }

  test("from a 0.31.0 host, reads the body without the transcript, then the transcript a page at a time", async () => {
    const { room: r, request } = room(huge, NOTE_PAGES_SCHEMA);
    const note = await readWholePeerNote(r, "d2", { workspaceId: "w1", note: "nabcdef1" });
    expect(note.markdown).toContain("Body text");
    expect(note.transcript).toBe(transcriptMarkdown(huge, "Standup"));
    const calls = request.mock.calls.map(([, method, params]) => [method, params]);
    expect(calls[0]).toEqual([
      "notes.read",
      { workspaceId: "w1", note: "nabcdef1", withoutTranscript: true },
    ]);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.slice(1).every(([method]) => method === "notes.transcript")).toBe(true);
  });

  test("small transcripts come out as the host would write them", async () => {
    const { room: r } = room(small, "0.31.2");
    const note = await readWholePeerNote(r, "d2", { workspaceId: "w1", note: "Standup" });
    expect(note.transcript).toBe(transcriptMarkdown(small, "Standup"));
  });

  test("an older host is asked as before", async () => {
    const { room: r, request } = room(small, "0.30.0");
    const note = await readWholePeerNote(r, "d2", { workspaceId: "w1", note: "nabcdef1" });
    expect(note.transcript).toBe(transcriptMarkdown(small, "Standup"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[2]).toEqual({ workspaceId: "w1", note: "nabcdef1" });
  });
});
