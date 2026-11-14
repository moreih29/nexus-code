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
});
