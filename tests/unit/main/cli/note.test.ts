/** nexus note list|read|path: the workspace's notes, as agents read them. */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { contentsOf } from "../../../../src/main/features/cli/commands/note";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { NoteContent } from "../../../../src/shared/notes/types";
import { API, APP, contextFor, type FakeApp, fakeApp } from "./fake-services";

const counts = { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 };

function note(
  id: string,
  title: string,
  text: string,
  extra: Partial<NoteContent> = {},
): NoteContent {
  return {
    id,
    title,
    createdAt: 0,
    updatedAt: 0,
    counts,
    excerpt: text,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    dir: `/data/notes/abc/${id}`,
    ...extra,
  };
}

function withNotes(): FakeApp {
  const app = fakeApp();
  app.notes[APP] = [
    note("nmhz00aa0001", "원격 파일 검색", "모바일 검색", {
      updatedAt: app.time.now - 60_000,
      counts: { ...counts, sketches: 1, todos: 2, todosDone: 1 },
    }),
    note("nmhy00bb0002", "", "제목 없는 메모", { updatedAt: Date.UTC(2026, 0, 2) }),
  ];
  return app;
}

const nexus = (app: FakeApp, argv: string[]) => runCli(CLI_COMMANDS, contextFor(app, argv));

describe("nexus note", () => {
  test("list: newest first, with what each has", async () => {
    const out = await nexus(withNotes(), ["note", "list"]);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^ID\s+TITLE\s+UPDATED\s+HAS/);
    expect(lines[1]).toContain("nmhz00aa0001");
    expect(lines[1]).toContain("원격 파일 검색");
    expect(lines[1]).toContain("1m ago");
    expect(lines[1]).toContain("to-dos 1/2, 1 sketch");
    expect(lines[2]).toContain("(untitled)");
    expect(lines[2]).toContain("2026-01-02");
  });

  test("list: none, and another workspace's", async () => {
    const app = withNotes();
    expect((await nexus(app, ["note", "list", "--workspace", "api"])).stdout).toBe(
      "No notes in api.\n",
    );
    app.notes[API] = [note("nmhz00cc0003", "API 메모", "x")];
    expect((await nexus(app, ["note", "list", "--workspace", "api"])).stdout).toContain("API 메모");
  });

  test("read: by id, prefix or title, as Markdown", async () => {
    const app = withNotes();
    for (const selector of ["nmhz00aa0001", "nmhz00aa", "원격 파일 검색"]) {
      const out = await nexus(app, ["note", "read", selector]);
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe(
        "# 원격 파일 검색\n\n모바일 검색\n\n<!-- The note's files: /data/notes/abc/nmhz00aa0001 -->\n",
      );
    }
    const json = await nexus(app, ["note", "read", "nmhy00bb", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      id: "nmhy00bb0002",
      markdown: "제목 없는 메모\n",
    });
  });

  test("read: an unknown note is an error", async () => {
    const out = await nexus(withNotes(), ["note", "read", "없는 노트"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('no note "없는 노트"');
  });

  test("path: the note's folder", async () => {
    const out = await nexus(withNotes(), ["note", "path", "nmhz00aa"]);
    expect(out.stdout).toBe("/data/notes/abc/nmhz00aa0001\n");
  });

  test("path and the folder in read: only in a terminal on the app's machine", async () => {
    const app = withNotes();
    const at = app.workspaces.findIndex((w) => w.id === APP);
    const own = app.workspaces[at] as (typeof app.workspaces)[number];
    app.workspaces[at] = { ...own, location: { kind: "ssh", host: "box", remotePath: "/w/app" } };
    const path = await nexus(app, ["note", "path", "nmhz00aa"]);
    expect(path.exitCode).not.toBe(0);
    expect(path.stderr).toContain("use nexus note read");
    const read = await nexus(app, ["note", "read", "nmhz00aa"]);
    expect(read.stdout).not.toContain("The note's files");
  });

  test("what a note has, in words", () => {
    expect(contentsOf({ counts })).toBe("text");
    expect(contentsOf({ counts: { ...counts, files: 2, images: 1 } })).toBe("2 files, 1 image");
  });
});
