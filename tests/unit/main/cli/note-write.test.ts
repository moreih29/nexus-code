import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { DocNode } from "../../../../src/shared/notes/markdown";
import type { NoteContent } from "../../../../src/shared/notes/types";
import { API, APP, contextFor, type FakeApp, fakeApp, READABLE, SHELL_TAB } from "./fake-services";

const NOTE = "nmhz00aa0001";

function withNote(): FakeApp {
  const app = fakeApp();
  const note: NoteContent = {
    id: NOTE,
    title: "Weekly",
    createdAt: 0,
    updatedAt: 0,
    counts: { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 },
    excerpt: "",
    doc: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Agenda" }] },
        { type: "paragraph", content: [{ type: "text", text: "budget" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Actions" }] },
      ],
    },
    dir: `/data/notes/app/${NOTE}`,
  };
  app.notes[APP] = [note];
  return app;
}

const nexus = (app: FakeApp, argv: string[], stdin?: string) =>
  runCli(
    CLI_COMMANDS,
    contextFor(
      app,
      argv,
      { workspaceId: APP, tabId: SHELL_TAB },
      stdin === undefined ? {} : { stdin },
    ),
  );

function blocksOf(app: FakeApp): DocNode[] {
  return app.notes[APP]?.find((n) => n.id === NOTE)?.doc.content ?? [];
}

const textOf = (b: DocNode | undefined): string =>
  (b?.content ?? []).map((c) => c.text ?? textOf(c)).join("");

describe("note new and note show", () => {
  test("makes a note, opening it in front of the user with --show", async () => {
    const app = fakeApp();
    const made = await nexus(app, ["note", "new", "Design", "review", "--show"]);
    expect(made.stdout).toBe('Made the note "Design review" (nnew0000) and opened it.\n');
    expect(app.uiCalls.find((c) => c.op === "note.show")?.args).toEqual({
      workspaceId: APP,
      noteId: "nnew0000",
      title: "Design review",
    });
    const shown = await nexus(withNote(), ["note", "show", "Weekly"]);
    expect(shown.stdout).toBe('Opened the note "Weekly" (nmhz00aa0001).\n');
  });

  test("another workspace's notes are changed only as the user allows", async () => {
    const app = withNote();
    app.notes[API] = app.notes[APP] ?? [];
    const denied = await nexus(app, ["note", "write", "Weekly", "hi", "--workspace", "api"]);
    expect(denied.stderr).toBe("nexus: the user did not allow it\n");
    expect(app.asked[0]?.change).toEqual({
      kind: "noteWrite",
      detail: "Weekly",
      body: "hi",
      eachTime: true,
    });
    expect(blocksOf(app)).toHaveLength(3);
  });
});

describe("note write", () => {
  test("adds Markdown at the end, or at the end of a heading's part", async () => {
    const app = withNote();
    await nexus(app, ["note", "write", "Weekly", "-"], "- [ ] send the deck\n");
    const under = await nexus(app, [
      "note",
      "write",
      "weekly",
      "**headcount**",
      "--under",
      "agenda",
    ]);
    expect(under.stdout).toBe('Wrote into the note "Weekly" (nmhz00aa0001) under "agenda".\n');
    const blocks = blocksOf(app);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "heading",
      "taskList",
    ]);
    expect(textOf(blocks[2])).toBe("headcount");
    const none = await nexus(app, ["note", "write", "Weekly", "x", "--under", "Nope"]);
    expect(none.stderr).toContain('has no heading "Nope"');
    expect((await nexus(app, ["note", "write", "Weekly", " "])).stderr).toContain(
      "nothing to write",
    );
  });

  test("an image of this computer goes into the note and shows; one on the web is linked", async () => {
    const app = withNote();
    READABLE["/w/app/out/chart a.png"] = "png bytes";
    const result = await nexus(
      app,
      ["note", "write", NOTE, "-"],
      "Sales rose.\n\n![Sales](out/chart%20a.png)\n\n![logo](https://x.y/logo.png)\n",
    );
    expect(result.exitCode).toBe(0);
    expect(app.noteAssets).toEqual([
      { noteId: NOTE, src: "screens/chart a.png", text: "png bytes" },
    ]);
    const blocks = blocksOf(app).slice(3);
    expect(blocks[1]).toEqual({
      type: "noteImage",
      attrs: { src: "screens/chart a.png", alt: "Sales" },
    });
    expect(blocks[2]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "logo",
          marks: [{ type: "link", attrs: { href: "https://x.y/logo.png" } }],
        },
      ],
    });
    const missing = await nexus(app, ["note", "write", NOTE, "![x](gone.png)"]);
    expect(missing.stderr).toContain("no file /w/app/gone.png");
  });
});

describe("note add", () => {
  test("puts images in to show and other files to attach, read where the terminal runs", async () => {
    const app = withNote();
    READABLE["/w/app/plot.png"] = "p";
    READABLE["/w/app/data.csv"] = "a,b";
    const result = await nexus(app, [
      "note",
      "add",
      NOTE,
      "plot.png",
      "data.csv",
      "--under",
      "Agenda",
    ]);
    expect(result.stdout).toBe(
      'Put into the note "Weekly" (nmhz00aa0001):\n  screens/plot.png\n  materials/data.csv\n',
    );
    expect(blocksOf(app).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "noteImage",
      "noteFile",
      "heading",
    ]);
  });
});

describe("note record", () => {
  test("says whether it can record, and starts only as the user allows, each time", async () => {
    const app = withNote();
    app.uiAnswers.set("note.recorder", (args) => {
      const { action } = args as { action: string };
      return action === "start"
        ? { phase: "recording", workspaceId: APP, noteId: NOTE, elapsedMs: 4_000, voice: "ready" }
        : { phase: "idle", voice: "signed-out" };
    });
    const status = await nexus(app, ["note", "record"]);
    expect(status.stdout).toBe(
      "Nothing records now. Recording needs a NexusCode sign-in (Settings › Remote).\n",
    );
    const denied = await nexus(app, ["note", "record", "Weekly"]);
    expect(denied.stderr).toBe("nexus: the user did not allow it\n");
    expect(app.asked[0]?.change).toEqual({ kind: "noteRecord", detail: "Weekly", eachTime: true });
    app.answers.push("once");
    const started = await nexus(app, ["note", "record", "Weekly"]);
    expect(started.stdout).toBe('Recording into "Weekly" (nmhz00aa0001): 0:04 (recording).\n');
    const starts = app.uiCalls.filter(
      (c) => c.op === "note.recorder" && (c.args as { action: string }).action === "start",
    );
    expect(starts).toHaveLength(1);
  });

  test("pauses or stops the recording there is, without a note", async () => {
    const app = withNote();
    app.uiAnswers.set("note.recorder", (args) => {
      const { action } = args as { action: string };
      return action === "status"
        ? { phase: "recording", workspaceId: APP, noteId: NOTE, elapsedMs: 61_000, voice: "ready" }
        : { phase: "paused", workspaceId: APP, noteId: NOTE, elapsedMs: 61_000, voice: "ready" };
    });
    const paused = await nexus(app, ["note", "record", "--pause"]);
    expect(paused.stdout).toBe('The recording of "Weekly" (nmhz00aa0001) is paused at 1:01.\n');
    expect(app.asked).toEqual([]);
    const both = await nexus(app, ["note", "record", "Weekly", "--stop"]);
    expect(both.stderr).toContain("leave out <note>");
  });
});
