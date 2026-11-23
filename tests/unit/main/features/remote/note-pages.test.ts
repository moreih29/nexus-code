import { describe, expect, mock, test } from "bun:test";
import {
  MAX_NOTE_MARKDOWN_PAGE,
  MAX_TRANSCRIPT_LINES,
  NOTE_PAGES_SCHEMA,
  RPC_METHODS,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { noteMarkdown } from "../../../../../src/main/features/notes/store";
import { listNotes, noteTranscript, readNote } from "../../../../../src/main/features/remote/notes";
import {
  MAX_NOTE_READS,
  readWholePeerNote,
} from "../../../../../src/main/features/remote/peer-notes";
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

const bigDoc = {
  type: "doc",
  content: Array.from({ length: 6000 }, (_, i) => ({
    type: "paragraph",
    content: [{ type: "text", text: `문단 ${i} 😀${"가".repeat(97)}👍🏽` }],
  })),
};

function servicesWith(file: TranscriptFile, withRecording = true, body = doc): CliServices {
  const note = {
    id: "nabcdef1",
    title: "Standup",
    updatedAt: 1000,
    doc: body,
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

describe("notes.read of a body a page at a time", () => {
  const big = servicesWith(small, true, bigDoc);
  const whole = noteMarkdown({ title: "Standup", doc: bigDoc } as never);
  const page = (markdownStart?: number, markdownLimit?: number) =>
    readNote(big, {
      workspaceId: "w1",
      note: "nabcdef1",
      withoutTranscript: true,
      ...(markdownStart === undefined ? {} : { markdownStart }),
      ...(markdownLimit === undefined ? {} : { markdownLimit }),
    });

  test("a body over a frame is refused whole, so an older reader never takes a part for all", async () => {
    expect(whole.length).toBeGreaterThan(MAX_NOTE_MARKDOWN_PAGE);
    await expect(
      readNote(big, { workspaceId: "w1", note: "nabcdef1", withoutTranscript: true }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
  });

  test("pages that each fit join into the body exactly, never cut inside a surrogate pair", async () => {
    let markdown = "";
    let pages = 0;
    for (;;) {
      const got = await page(markdown.length);
      pages++;
      expect(fitsAsResult(got)).toBe(true);
      expect(got.markdownStart).toBe(markdown.length);
      expect(got.markdownTotal).toBe(whole.length);
      expect(got.markdown.length).toBeLessThanOrEqual(MAX_NOTE_MARKDOWN_PAGE);
      expect(got.markdown.length).toBeGreaterThan(0);
      expect(got.markdown.isWellFormed()).toBe(true);
      expect(got.recordings).toHaveLength(2);
      markdown += got.markdown;
      if (markdown.length >= (got.markdownTotal ?? 0)) break;
    }
    expect(pages).toBeGreaterThan(2);
    expect(markdown).toBe(whole);
  });

  test("an emoji is sent whole at either end of a page", async () => {
    const s = servicesWith(small, false, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a😀b" }] }],
    });
    const at = (markdownStart: number, markdownLimit: number) =>
      readNote(s, {
        workspaceId: "w1",
        note: "nabcdef1",
        withoutTranscript: true,
        markdownStart,
        markdownLimit,
      });
    const body = noteMarkdown({ title: "Standup", doc: { type: "doc", content: [] } } as never);
    const emoji = body.length + 1;
    expect(await at(emoji - 1, 2)).toMatchObject({ markdown: "a", markdownStart: emoji - 1 });
    expect(await at(emoji, 1)).toMatchObject({ markdown: "😀", markdownStart: emoji });
    expect(await at(emoji + 1, 2)).toMatchObject({ markdown: "😀", markdownStart: emoji });
    const end = await at(9999, 5);
    expect(end).toMatchObject({ markdown: "", markdownStart: end.markdownTotal });
  });

  test("markdownStart or markdownLimit without withoutTranscript is refused", async () => {
    await expect(
      readNote(big, { workspaceId: "w1", note: "nabcdef1", markdownStart: 0 }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    await expect(
      readNote(big, { workspaceId: "w1", note: "nabcdef1", markdownLimit: 5 }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  });

  test("markdownLimit is bounded by the protocol", () => {
    const params = RPC_METHODS["notes.read"].params;
    const base = { workspaceId: "w1", note: "n", withoutTranscript: true };
    expect(params.safeParse({ ...base, markdownLimit: MAX_NOTE_MARKDOWN_PAGE }).success).toBe(true);
    expect(params.safeParse({ ...base, markdownLimit: MAX_NOTE_MARKDOWN_PAGE + 1 }).success).toBe(
      false,
    );
    expect(params.safeParse({ ...base, markdownLimit: 0 }).success).toBe(false);
    expect(params.safeParse({ ...base, markdownStart: -1 }).success).toBe(false);
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
  function room(file: TranscriptFile, schema: string | undefined, body = doc) {
    const s = servicesWith(file, true, body);
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
      { workspaceId: "w1", note: "nabcdef1", withoutTranscript: true, markdownStart: 0 },
    ]);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.slice(1).every(([method]) => method === "notes.transcript")).toBe(true);
  });

  test("a body over a frame comes in pages from a 0.31.0 host, exactly as written", async () => {
    const { room: r, request } = room(small, NOTE_PAGES_SCHEMA, bigDoc);
    const note = await readWholePeerNote(r, "d2", { workspaceId: "w1", note: "Standup" });
    expect(note.markdown).toBe(noteMarkdown({ title: "Standup", doc: bigDoc } as never));
    expect(note.transcript).toBe(transcriptMarkdown(small, "Standup"));
    const reads = request.mock.calls.filter(([, method]) => method === "notes.read");
    expect(reads.length).toBeGreaterThan(2);
    expect(
      reads.slice(1).every(([, , params]) => (params as { note: string }).note === "nabcdef1"),
    ).toBe(true);
  });

  test("a body over a frame from an older host fails as before, asked once", async () => {
    const { room: r, request } = room(small, "0.30.0", bigDoc);
    await expect(
      readWholePeerNote(r, "d2", { workspaceId: "w1", note: "nabcdef1" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
    expect(request).toHaveBeenCalledTimes(1);
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

describe("a note that changes while another computer reads it in pages", () => {
  function live(file: TranscriptFile, body: object) {
    const note = {
      id: "nabcdef1",
      title: "Standup",
      updatedAt: 1000,
      doc: body,
      recording: { recordings: file.recordings.length, ms: 1, people: 2 },
    };
    const state = { note, file };
    const s = {
      listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
      notes: {
        list: async () => [state.note],
        read: async () => state.note,
        transcript: async () => state.file,
      },
    } as unknown as CliServices;
    let calls = 0;
    const hooks: { after?: (call: number, method: RpcMethod) => void } = {};
    const request = mock(async (_to: string, method: RpcMethod, params: object) => {
      const parsed = RPC_METHODS[method].params.parse(params) as never;
      const result =
        method === "notes.read" ? await readNote(s, parsed) : await noteTranscript(s, parsed);
      hooks.after?.(++calls, method);
      return result;
    });
    const room = {
      request: request as never,
      state: () => ({
        status: "online" as const,
        peers: [
          { id: "d2", name: "mini", platform: "darwin", online: true, schema: NOTE_PAGES_SCHEMA },
        ],
      }),
    };
    return { state, hooks, request, room };
  }

  const editedDoc = {
    ...bigDoc,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Inserted first" }] },
      ...bigDoc.content,
    ],
  };

  test("an edit between body pages starts the body again, and the edited body comes whole", async () => {
    const { state, hooks, request, room } = live(small, bigDoc);
    hooks.after = (call) => {
      if (call === 1) state.note = { ...state.note, doc: editedDoc, updatedAt: 2000 };
    };
    const note = await readWholePeerNote(room, "d2", { workspaceId: "w1", note: "nabcdef1" });
    expect(note.markdown).toBe(noteMarkdown({ title: "Standup", doc: editedDoc } as never));
    expect(note.updatedAt).toBe(2000);
    const starts = request.mock.calls
      .filter(([, method]) => method === "notes.read")
      .map(([, , params]) => (params as { markdownStart?: number }).markdownStart);
    expect(starts.filter((at) => at === 0)).toHaveLength(2);
  });

  test("a note that keeps changing is given up after a few reads", async () => {
    const { state, hooks, request, room } = live(small, bigDoc);
    hooks.after = (_call, method) => {
      if (method === "notes.read")
        state.note = { ...state.note, updatedAt: state.note.updatedAt + 1 };
    };
    await expect(
      readWholePeerNote(room, "d2", { workspaceId: "w1", note: "nabcdef1" }),
    ).rejects.toThrow("kept changing");
    expect(request.mock.calls.length).toBe(2 * MAX_NOTE_READS);
  });

  test("a transcript rewritten between pages is read again; one that only grows is not", async () => {
    const long: TranscriptFile = { version: 1, recordings: [recording("rabcdef1234", 2500)] };
    const rewritten: TranscriptFile = {
      version: 1,
      recordings: [recording("rabcdef1234", 2200, (i) => `again ${i}`)],
    };
    const changed = live(long, doc);
    changed.hooks.after = (call, method) => {
      if (method === "notes.transcript" && call === 3) changed.state.file = rewritten;
    };
    const note = await readWholePeerNote(changed.room, "d2", {
      workspaceId: "w1",
      note: "nabcdef1",
    });
    expect(note.transcript).toBe(transcriptMarkdown(rewritten, "Standup"));

    const grown: TranscriptFile = {
      version: 1,
      recordings: [
        { ...recording("rabcdef1234", 2600), lines: recording("rabcdef1234", 2600).lines },
      ],
    };
    const growing = live(long, doc);
    growing.hooks.after = (call, method) => {
      if (method === "notes.transcript" && call === 3) growing.state.file = grown;
    };
    const read = await readWholePeerNote(growing.room, "d2", {
      workspaceId: "w1",
      note: "nabcdef1",
    });
    expect(read.transcript).toBe(transcriptMarkdown(grown, "Standup"));
    expect(
      growing.request.mock.calls.filter(
        ([, method, params]) =>
          method === "notes.transcript" && (params as { start: number }).start === 0,
      ),
    ).toHaveLength(1);
  });

  test("a transcript that shrinks below the lines already read is read again, not cut", async () => {
    const before: TranscriptFile = { version: 1, recordings: [recording("rabcdef1234", 2500)] };
    const shrinks: TranscriptFile[] = [800, 1000].map((count) => ({
      version: 1,
      recordings: [recording("rabcdef1234", count)],
    }));
    for (const shrunk of shrinks) {
      const r = live(before, doc);
      r.hooks.after = (call, method) => {
        if (method === "notes.transcript" && call === 2) r.state.file = shrunk;
      };
      const note = await readWholePeerNote(r.room, "d2", { workspaceId: "w1", note: "nabcdef1" });
      expect(note.transcript).toBe(transcriptMarkdown(shrunk, "Standup"));
      expect(note.recordings?.[0]?.lines).toBe(shrunk.recordings[0]?.lines.length);
    }
  });
});
