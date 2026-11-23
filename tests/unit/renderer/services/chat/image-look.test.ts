import { describe, expect, it } from "bun:test";
import {
  conversationLook,
  imageLookSize,
  latestReadFile,
  lookAtImage,
  sameImage,
  shownIndex,
} from "../../../../../src/renderer/services/chat/image-look";
import type { ImageBlock } from "../../../../../src/renderer/services/chat/model";

const AREA = { w: 1220, h: 620 };

describe("quick look's size around an image", () => {
  it("wraps a wide screenshot fitted to the area 64px in, under its header", () => {
    expect(imageLookSize(AREA, { w: 2560, h: 1600 }, 2)).toEqual({ w: 728, h: 492 });
  });

  it("makes a small image as large as a big one: the same height, so stepping keeps it", () => {
    expect(imageLookSize(AREA, { w: 256, h: 256 }, 2)).toEqual({ w: 456, h: 492 });
  });

  it("keeps room for the header beside a tall, narrow image", () => {
    expect(imageLookSize(AREA, { w: 600, h: 2000 }, 2)).toEqual({ w: 362, h: 492 });
  });

  it("is narrower than that only where the area is", () => {
    expect(imageLookSize({ w: 300, h: 260 }, { w: 2560, h: 1600 })).toEqual({ w: 172, h: 132 });
  });

  it("has none where the area has no room, or the image no size", () => {
    expect(imageLookSize({ w: 200, h: 150 }, { w: 100, h: 100 })).toBeNull();
    expect(imageLookSize(AREA, { w: 0, h: 0 })).toBeNull();
  });
});

const block = (data: string): ImageBlock => ({ mediaType: "image/png", data });
const ref = (toolUseId: string, index = 0): ImageBlock => ({
  mediaType: "image/png",
  data: "",
  remote: { kind: "tool", toolUseId, index },
});
const all = async (files: string[]) => new Set(files);

describe("which image quick look opens", () => {
  it("opens the read that was clicked among reads of the same file", () => {
    const [a, b, c] = [block("a"), block("b"), block("c")];
    const shown = [
      { file: "/tmp/x.png", image: a },
      { file: "/tmp/x.png", image: b },
      { file: "/tmp/x.png", image: c },
    ];
    expect(shownIndex(shown, { image: c })).toBe(2);
    expect(shownIndex(shown, { file: "/tmp/x.png", image: b })).toBe(1);
  });

  it("never takes another block for the same bytes", () => {
    const [a, b] = [block("same"), block("same")];
    const shown = [{ image: a }, { image: b }];
    expect(shownIndex(shown, { image: b })).toBe(1);
    expect(shownIndex(shown, { image: block("same") })).toBe(-1);
  });

  it("tells another computer's images apart by their refs, before their bytes come", () => {
    const shown = [
      { file: "/tmp/x.png", image: ref("t1") },
      { file: "/tmp/x.png", image: ref("t2") },
    ];
    expect(shownIndex(shown, { image: ref("t2") })).toBe(1);
    expect(shownIndex(shown, { image: ref("t1", 1) })).toBe(-1);
    expect(sameImage(ref("t1"), ref("t1"))).toBe(true);
    expect(sameImage(ref("t1"), ref("t2"))).toBe(false);
    expect(sameImage(ref("t1"), block(""))).toBe(false);
  });

  it("finds a file link at the entry with no data, else the last read", () => {
    const shown = [
      { file: "/tmp/x.png", image: block("a") },
      { file: "/tmp/y.png" },
      { file: "/tmp/x.png", image: block("b") },
    ];
    expect(shownIndex(shown, { file: "/tmp/y.png" })).toBe(1);
    expect(shownIndex(shown, { file: "/tmp/x.png" })).toBe(2);
    expect(shownIndex(shown, { file: "/tmp/z.png" })).toBe(-1);
  });
});

describe("what quick look shows of each image", () => {
  it("shows each read of one file from its own data, keeping the file for its actions", () => {
    const [a, b] = [block("a"), block("b")];
    const look = conversationLook(
      [
        { file: "/tmp/x.png", image: a },
        { file: "/tmp/x.png", image: b },
      ],
      1,
      () => true,
    );
    expect(look.files).toEqual(["image:1", "image:2"]);
    expect(look.index).toBe(1);
    expect(look.images).toEqual({ "image:1": a, "image:2": b });
    expect(look.paths).toEqual({ "image:1": "/tmp/x.png", "image:2": "/tmp/x.png" });
  });

  it("shows another computer's ref by it, though its bytes are not here", () => {
    const r = ref("t1");
    const look = conversationLook([{ file: "/tmp/x.png", image: r }], 0, () => false);
    expect(look.files).toEqual(["image:1"]);
    expect(look.images["image:1"]).toBe(r);
  });

  it("shows an image with no data as its file, when it is there", () => {
    const look = conversationLook([{ file: "/tmp/x.png" }, { image: block("p") }], 0, () => true);
    expect(look.files).toEqual(["/tmp/x.png", "image:1"]);
    expect(look.paths).toBeUndefined();
  });

  it("leaves out a gone file with no data, unless it is the one opened", () => {
    expect(
      conversationLook([{ file: "/gone.png" }, { image: block("p") }], 1, () => false).files,
    ).toEqual(["image:1"]);
    expect(conversationLook([{ file: "/gone.png" }], 0, () => false).files).toEqual(["/gone.png"]);
  });
});

describe("looking at an image", () => {
  it("opens the clicked one of 3 reads of a file, as it was read", async () => {
    const [a, b, c] = [block("a"), block("b"), block("c")];
    const shown = [a, b, c].map((image) => ({ file: "/tmp/x.png", image }));
    const look = await lookAtImage(shown, { file: "/tmp/x.png", image: a }, all);
    expect(look?.index).toBe(0);
    expect(look?.images[look.files[0]]).toBe(a);
    const last = await lookAtImage(shown, { file: "/tmp/x.png", image: c }, all);
    expect(last?.images[last.files[last.index]]).toBe(c);
  });

  it("gives null for an image that is not among them, and a file link shows the file as it is", async () => {
    const shown = [{ file: "/tmp/x.png", image: block("a") }];
    expect(await lookAtImage(shown, { image: block("a") }, all)).toBeNull();
    const link = await lookAtImage(shown, { file: "/tmp/x.png" }, all);
    expect(link?.files).toEqual(["/tmp/x.png"]);
    const fresh = await lookAtImage(shown, { file: "/tmp/new.png" }, all);
    expect(fresh?.files[0]).toBe("/tmp/new.png");
    expect(fresh?.index).toBe(0);
  });
});

describe("the read a held file stands for", () => {
  it("is the last read of a file, not an earlier one", () => {
    const [a, b] = [block("a"), block("b")];
    const shown = [
      { file: "/tmp/x.png", image: a },
      { file: "/tmp/y.png", image: block("y") },
      { file: "/tmp/x.png", image: b },
    ];
    expect(latestReadFile(shown, { image: b })).toBe("/tmp/x.png");
    expect(latestReadFile(shown, { image: a })).toBeUndefined();
  });

  it("is the last read by another computer's ref too", () => {
    const shown = [
      { file: "/tmp/x.png", image: ref("t1") },
      { file: "/tmp/x.png", image: ref("t2") },
    ];
    expect(latestReadFile(shown, { image: ref("t2") })).toBe("/tmp/x.png");
    expect(latestReadFile(shown, { image: ref("t1") })).toBeUndefined();
  });

  it("is none for an image with no file or not among them", () => {
    expect(latestReadFile([{ image: block("p") }], { image: block("p") })).toBeUndefined();
    expect(latestReadFile([], { image: block("p") })).toBeUndefined();
  });
});

describe("the files a look opens by path", () => {
  it("names a file for each image shown from its data, which the file actions use", () => {
    const look = conversationLook(
      [
        { file: "/out/side.png", image: block("a") },
        { image: block("pasted") },
        { file: "/out/side.png" },
      ],
      0,
      () => true,
    );
    expect(look.files).toEqual(["image:1", "image:2", "/out/side.png"]);
    expect(look.paths).toEqual({ "image:1": "/out/side.png" });
  });
});

describe("images the chat shows in full, with no data", () => {
  // A conversation as one had it: 10 images read, a mockup read then sent
  // with one never read (outside the workspace), then 3 sent from inside it.
  const before = Array.from({ length: 10 }, (_, i) => ({
    file: `/ws/shot-${i}.png`,
    image: block(`s${i}`),
  }));
  const tree = "/tmp/shots/tree.png";
  const top = "/tmp/shots/top.png";
  const shown = [
    ...before,
    { file: tree, image: block("tree") },
    { file: top, placed: true as const },
    { file: "/ws/a2.png", image: block("a2") },
    { file: "/ws/ws-a2.png", image: block("ws-a2") },
    { file: "/ws/mix.png", placed: true as const },
  ];
  // Nothing found at the moment: a lookup refused, as one the files' host is too busy for.
  const none = async () => new Set<string>();

  it("keeps a placed file a step away though no lookup finds it", () => {
    const look = conversationLook(
      [
        { file: "/a.png", image: block("a") },
        { file: top, placed: true },
      ],
      0,
      () => false,
    );
    expect(look.files).toEqual(["image:1", top]);
  });

  it("opens each at its place among all of them, first, between and last", async () => {
    const at = async (target: { file?: string; image?: ImageBlock }) => {
      const look = await lookAtImage(shown, target, none);
      return (
        look && { count: look.files.length, number: look.index + 1, at: look.files[look.index] }
      );
    };
    expect(await at({ image: before[0].image })).toEqual({ count: 15, number: 1, at: "image:1" });
    expect(await at({ file: tree })).toEqual({ count: 15, number: 11, at: tree });
    expect(await at({ file: top })).toEqual({ count: 15, number: 12, at: top });
    expect(await at({ file: "/ws/mix.png" })).toEqual({
      count: 15,
      number: 15,
      at: "/ws/mix.png",
    });
  });

  it("steps from the first of the two sent to the second", async () => {
    const look = await lookAtImage(shown, { file: tree }, none);
    expect(look?.files[(look.index + 1) % look.files.length]).toBe(top);
  });

  it("looks up only the files it has no data or picture of", async () => {
    const asked: string[][] = [];
    const named = [...shown, { file: "/tmp/named.png" }];
    const look = await lookAtImage(named, { file: tree }, async (files) => {
      asked.push(files);
      return new Set<string>();
    });
    expect(asked).toEqual([["/tmp/named.png"]]);
    // One only named, and not found, is still left out.
    expect(look?.files).toHaveLength(15);
    expect(
      await lookAtImage(shown, { file: tree }, async () => {
        throw new Error("asked for nothing");
      }),
    ).not.toBeNull();
  });
});
