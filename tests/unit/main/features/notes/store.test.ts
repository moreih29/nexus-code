import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assetsOf,
  countsOf,
  excerptOf,
  locationDirName,
  NoteError,
  NotesStore,
  PRUNE_AFTER_MS,
  safeName,
} from "../../../../../src/main/features/notes/store";
import type { NoteLocation } from "../../../../../src/shared/notes/types";

let root: string;
let store: NotesStore;
const here: NoteLocation = {
  key: "local:/Users/me/ws",
  kind: "local",
  path: "/Users/me/ws",
  label: "ws",
};
const there: NoteLocation = {
  key: "local:/Users/me/other",
  kind: "local",
  path: "/Users/me/other",
  label: "other",
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "notes-"));
  store = new NotesStore(path.join(root, "notes"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("notes on disk", () => {
  test("a new note is listed under its location only", async () => {
    const note = await store.create(here, "아이디어");
    expect(note.title).toBe("아이디어");
    expect(note.dir).toBe(path.join(root, "notes", locationDirName(here.key), note.id));
    expect((await store.list(here)).map((n) => n.id)).toEqual([note.id]);
    expect(await store.list(there)).toEqual([]);
    const location = JSON.parse(
      await fs.readFile(
        path.join(root, "notes", locationDirName(here.key), "location.json"),
        "utf8",
      ),
    );
    expect(location).toEqual(here);
  });

  test("saving writes the document and its Markdown, newest first in the list", async () => {
    const a = await store.create(here, "a");
    const b = await store.create(here, "b");
    // Saved in the millisecond b was made, a would tie with it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save(here, a.id, { title: "첫 노트", doc: doc("본문입니다") });
    const list = await store.list(here);
    expect(list.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(list[0]?.excerpt).toBe("본문입니다");
    expect(await fs.readFile(path.join(a.dir, "note.md"), "utf8")).toBe(
      "# 첫 노트\n\n본문입니다\n",
    );
    const read = await store.read(here, a.id);
    expect(read.doc).toEqual(doc("본문입니다"));
    expect(read.title).toBe("첫 노트");
  });

  test("a missing note or a bad id is an error, not a path", async () => {
    await expect(store.read(here, "n000000missing")).rejects.toBeInstanceOf(NoteError);
    expect(() => store.noteDir(here, "../x")).toThrow(NoteError);
    await expect(store.save(here, "n000000missing", { title: "x" })).rejects.toBeInstanceOf(
      NoteError,
    );
  });

  test("files are copied under a free name; images and sketches get their folders", async () => {
    const note = await store.create(here);
    const src = path.join(root, "제안서.pdf");
    await fs.writeFile(src, "pdf");
    const first = await store.addFile(here, note.id, src);
    const second = await store.addFile(here, note.id, src);
    expect(first).toEqual({ src: "materials/제안서.pdf", name: "제안서.pdf", size: 3 });
    expect(second.src).toBe("materials/제안서 (2).pdf");
    const image = await store.addImage(
      here,
      note.id,
      new Uint8Array([1, 2, 3]),
      "png",
      "검색 결과.png",
    );
    expect(image.src).toBe("screens/검색 결과.png");
    const sketch = await store.saveSketch(here, note.id, { scene: "{}", svg: "<svg/>" });
    expect(sketch.src).toBe(`sketches/${sketch.id}.svg`);
    expect((await store.readAsset(here, note.id, sketch.src)).toString()).toBe("<svg/>");
    const again = await store.saveSketch(here, note.id, {
      id: sketch.id,
      scene: "{1}",
      svg: "<svg>2</svg>",
    });
    expect(again.id).toBe(sketch.id);
    expect((await store.readAsset(here, note.id, again.scene)).toString()).toBe("{1}");
  });

  test("photos that come at once each get a name of their own, and all go into the note", async () => {
    const note = await store.create(here);
    const bytes = (n: number) => new Uint8Array([n, n, n]);
    const assets = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => store.addPhoto(here, note.id, bytes(n), "jpg", "IMG_0001")),
    );
    const names = assets.map((a) => a.name).sort();
    expect(names).toEqual([
      "IMG_0001 (2).jpg",
      "IMG_0001 (3).jpg",
      "IMG_0001 (4).jpg",
      "IMG_0001 (5).jpg",
      "IMG_0001.jpg",
    ]);
    // None wrote over another.
    const kept = await Promise.all(assets.map((a) => store.readAsset(here, note.id, a.src)));
    expect(kept.map((b) => b[0]).sort()).toEqual([1, 2, 3, 4, 5]);
    const read = await store.read(here, note.id);
    const srcs = (read.doc.content ?? []).map((n) => (n.attrs as { src?: string })?.src);
    expect(srcs.filter(Boolean).sort()).toEqual(assets.map((a) => a.src).sort());
  });

  test("prune clears the files the document no longer uses, but not ones just written", async () => {
    const note = await store.create(here);
    const sketch = await store.saveSketch(here, note.id, { scene: "{}", svg: "<svg/>" });
    const kept = await store.addImage(here, note.id, Buffer.from("png"), "png", "kept.png");
    const gone = await store.addImage(here, note.id, Buffer.from("png"), "png", "gone.png");
    await store.save(here, note.id, {
      doc: {
        type: "doc",
        content: [
          { type: "sketch", attrs: { id: sketch.id, src: sketch.src } },
          { type: "noteImage", attrs: { src: kept.src } },
        ],
      },
    });
    const now = Date.now();
    // Only just written: nothing goes, used or not.
    expect(await store.prune(here, note.id, now)).toEqual([]);
    const later = now + PRUNE_AFTER_MS + 1000;
    expect(await store.prune(here, note.id, later)).toEqual([gone.src]);
    const dir = store.noteDir(here, note.id);
    expect(await fs.readdir(path.join(dir, "screens"))).toEqual(["kept.png"]);
    expect((await fs.readdir(path.join(dir, "sketches"))).sort()).toEqual(
      [`${sketch.id}.excalidraw`, `${sketch.id}.svg`].sort(),
    );
  });

  test("the files a document uses: a sketch's scene and picture, images and files", () => {
    const used = assetsOf({
      type: "doc",
      content: [
        { type: "sketch", attrs: { id: "s1234", src: "sketches/s1234.svg" } },
        { type: "sketch", attrs: {} },
        { type: "noteFile", attrs: { src: "materials/a.pdf", name: "a.pdf" } },
        { type: "paragraph", content: [{ type: "noteImage", attrs: { src: "screens/b.png" } }] },
      ],
    });
    expect([...used].sort()).toEqual([
      "materials/a.pdf",
      "screens/b.png",
      "sketches/s1234.excalidraw",
      "sketches/s1234.svg",
    ]);
  });

  test("an asset path never leaves the note's folder", async () => {
    const note = await store.create(here);
    expect(() => store.assetPath(here, note.id, "../../location.json")).toThrow(NoteError);
    expect(() => store.assetPath(here, note.id, "/etc/passwd")).toThrow(NoteError);
    await expect(store.addImage(here, note.id, new Uint8Array(), "svg")).rejects.toBeInstanceOf(
      NoteError,
    );
  });

  test("storage lists every location with what it takes; removing goes to the trash", async () => {
    const trashed: string[] = [];
    store = new NotesStore(path.join(root, "notes"), async (dir) => {
      trashed.push(dir);
      await fs.rm(dir, { recursive: true });
    });
    const a = await store.create(here, "a");
    await store.addImage(here, a.id, new Uint8Array(10), "png");
    await store.create(there, "b");
    const entries = await store.storage();
    expect(entries.map((e) => e.location.key).sort()).toEqual([here.key, there.key].sort());
    const mine = entries.find((e) => e.location.key === here.key);
    expect(mine?.notes).toBe(1);
    expect(mine?.bytes.images).toBe(10);
    await store.remove(here, a.id);
    expect(trashed).toEqual([a.dir]);
    expect(await store.list(here)).toEqual([]);
    await store.removeLocation(there.key);
    expect(await store.storage()).toEqual([]);
  });
});

describe("a photo from the user's phone", () => {
  test("is written into screens/ and put at the end of the note, whose text stays", async () => {
    const note = await store.create(here, "회의");
    await store.save(here, note.id, { doc: doc("화이트보드 정리") });
    const photo = await store.addPhoto(
      here,
      note.id,
      new Uint8Array([0xff, 0xd8, 0xff]),
      "jpg",
      "IMG_0001.HEIC",
    );
    expect(photo.src).toBe("screens/IMG_0001.jpg");
    const after = await store.read(here, note.id);
    expect(after.doc.content?.at(0)).toEqual(doc("화이트보드 정리").content[0]);
    expect(after.doc.content?.at(-1)).toEqual({
      type: "noteImage",
      attrs: { src: "screens/IMG_0001.jpg", alt: "IMG_0001.jpg" },
    });
    expect(after.counts.images).toBe(1);
    // The note's Markdown, which agents read, shows it too.
    const md = await fs.readFile(path.join(after.dir, "note.md"), "utf8");
    expect(md).toContain("screens/IMG_0001.jpg");
    // Unnamed, it is named by when it came; it is kept by prune, being in the document.
    const unnamed = await store.addPhoto(here, note.id, new Uint8Array([1]), "png");
    expect(unnamed.src).toMatch(/^screens\/photo-\d{8}-\d{6}\.png$/);
    expect(await store.prune(here, note.id)).toEqual([]);
  });

  test("goes nowhere for a note that is not there", async () => {
    await expect(
      store.addPhoto(here, "n0000000000", new Uint8Array([1]), "png"),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(await fs.readdir(path.join(root, "notes")).catch(() => [])).toEqual([]);
  });
});

describe("what a note has in it", () => {
  test("counts sketches, files, images and to-dos", () => {
    expect(
      countsOf({
        type: "doc",
        content: [
          { type: "sketch" },
          { type: "noteFile" },
          { type: "noteImage" },
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { checked: true } },
              { type: "taskItem", attrs: { checked: false } },
            ],
          },
        ],
      }),
    ).toEqual({ sketches: 1, files: 1, images: 1, todos: 2, todosDone: 1 });
  });

  test("an excerpt joins blocks with spaces and stops early", () => {
    const d = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "제목" }] },
        { type: "paragraph", content: [{ type: "text", text: "본문" }] },
      ],
    };
    expect(excerptOf(d)).toBe("제목 본문");
    expect(excerptOf(doc("가".repeat(300)), 10)).toBe("가".repeat(10));
  });

  test("a file name keeps no folders", () => {
    expect(safeName("../a/b.txt")).toBe("_a_b.txt");
    expect(safeName("...")).toBe("file");
  });

  test("a file name Windows can keep: no device names, no trailing dots or spaces", () => {
    expect(safeName("con")).toBe("_con");
    expect(safeName("NUL.png")).toBe("_NUL.png");
    expect(safeName("com1.tar.gz")).toBe("_com1.tar.gz");
    expect(safeName("console.png")).toBe("console.png");
    expect(safeName("보고서. ")).toBe("보고서");
  });
});

describe("a note's recordings", () => {
  const take = (n: number) => `recordings/rmhz00cc0abcd-${n}.webm`;
  const transcript = (over: Record<string, unknown> = {}) => ({
    version: 1 as const,
    recordings: [
      {
        id: "rmhz00cc0abcd",
        startedAt: 1,
        language: "ko",
        takes: [{ file: take(1), offsetMs: 0, seconds: 90, pass: "none" as const }],
        speakers: { "1": "지현" },
        lines: [
          { speaker: "1", startMs: 0, endMs: 2000, text: "시작할게요" },
          { speaker: "2", startMs: 2000, endMs: 3000, text: "네" },
        ],
        ...over,
      },
    ],
  });

  test("a note without one has an empty transcript and no recording in its row", async () => {
    const note = await store.create(here, "회의");
    expect(await store.readTranscript(here, note.id)).toEqual({ version: 1, recordings: [] });
    expect((await store.list(here))[0]?.recording).toBeUndefined();
  });

  test("writes transcript.json and .md, and the row says how long and how many people", async () => {
    const note = await store.create(here, "회의");
    await store.saveTranscript(here, note.id, transcript());
    expect(await store.readTranscript(here, note.id)).toEqual(transcript());
    const md = await fs.readFile(path.join(note.dir, "transcript.md"), "utf8");
    expect(md).toContain("# Transcript: 회의");
    expect(md).toContain("[0:00] 지현: 시작할게요");
    expect((await store.list(here))[0]?.recording).toEqual({
      recordings: 1,
      ms: 90_000,
      people: 2,
    });
    expect((await store.read(here, note.id)).recording?.people).toBe(2);
  });

  test("a take's audio is written piece by piece, only under recordings/", async () => {
    const note = await store.create(here, "");
    await store.appendAudio(here, note.id, take(1), new Uint8Array([1, 2]));
    await store.appendAudio(here, note.id, take(1), new Uint8Array([3]));
    expect([...(await fs.readFile(path.join(note.dir, take(1))))]).toEqual([1, 2, 3]);
    await expect(
      store.appendAudio(here, note.id, "note.json", new Uint8Array([0])),
    ).rejects.toThrow(NoteError);
    await expect(
      store.appendAudio(here, "nmissing00000", take(1), new Uint8Array([0])),
    ).rejects.toThrow(NoteError);
    const [entry] = await store.storage();
    expect(entry?.bytes.recordings).toBe(3);
  });

  test("removing a recording's audio keeps its words; with the text, it goes whole", async () => {
    const trashed: string[] = [];
    const withTrash = new NotesStore(path.join(root, "notes"), async (p) => {
      trashed.push(path.basename(p));
      await fs.rm(p, { recursive: true, force: true });
    });
    const note = await withTrash.create(here, "");
    await withTrash.saveTranscript(here, note.id, transcript());
    await withTrash.appendAudio(here, note.id, take(1), new Uint8Array([1]));
    await withTrash.appendAudio(here, note.id, take(2), new Uint8Array([2]));
    const kept = await withTrash.removeRecording(here, note.id, "rmhz00cc0abcd");
    expect(trashed.sort()).toEqual(["rmhz00cc0abcd-1.webm", "rmhz00cc0abcd-2.webm"]);
    expect(kept.recordings[0]?.audioRemoved).toBe(true);
    expect(kept.recordings[0]?.lines).toHaveLength(2);
    const gone = await withTrash.removeRecording(here, note.id, "rmhz00cc0abcd", true);
    expect(gone.recordings).toEqual([]);
    expect(await withTrash.readTranscript(here, note.id)).toEqual({ version: 1, recordings: [] });
  });

  test("prune leaves recordings alone", async () => {
    const note = await store.create(here, "");
    await store.appendAudio(here, note.id, take(1), new Uint8Array([1]));
    expect(await store.prune(here, note.id, Date.now() + PRUNE_AFTER_MS * 10)).toEqual([]);
  });
});
