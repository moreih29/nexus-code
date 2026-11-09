/**
 * The images a chat shows open in quick look among all of the
 * conversation's images: an image file as that file, while it is there,
 * any other from its data.
 */

import { describe, expect, test } from "bun:test";
import {
  conversationLook,
  imageFileOf,
  imageLook,
  imageSrc,
  lookAtImage,
  type ShownImage,
  shownIndex,
} from "../../../../../src/renderer/services/chat/image-look";

const A = { mediaType: "image/png", data: "AAAA" };
const B = { mediaType: "image/jpeg", data: "BBBB" };

describe("imageLook", () => {
  test("holds each image by a key no path is, at the one opened", () => {
    const look = imageLook([A, B], 1);
    expect(look.files).toEqual(["image:1", "image:2"]);
    expect(look.index).toBe(1);
    expect(look.images["image:1"]).toBe(A);
    expect(look.images["image:2"]).toBe(B);
  });

  test("opens at an image there is", () => {
    expect(imageLook([A, B], 5).index).toBe(1);
    expect(imageLook([A], -1).index).toBe(0);
  });
});

const C = { mediaType: "image/png", data: "CCCC" };

describe("shownIndex", () => {
  const shown: ShownImage[] = [{ image: A }, { file: "/p/a.png", image: B }, { file: "/p/b.png" }];

  test("finds an image file by its path", () => {
    expect(shownIndex(shown, { file: "/p/b.png" })).toBe(2);
    expect(shownIndex(shown, { file: "/p/a.png" })).toBe(1);
  });

  test("finds an image with no file by its data, the same block or the same bytes", () => {
    expect(shownIndex(shown, { image: A })).toBe(0);
    expect(shownIndex(shown, { image: { ...B } })).toBe(1);
  });

  test("is -1 for an image not among them", () => {
    expect(shownIndex(shown, { image: C })).toBe(-1);
    expect(shownIndex(shown, { file: "/p/z.png" })).toBe(-1);
    expect(shownIndex(shown, {})).toBe(-1);
  });
});

describe("conversationLook", () => {
  const shown: ShownImage[] = [
    { image: A },
    { file: "/p/gone.png" },
    { file: "/p/read.png", image: B },
    { file: "/p/here.png" },
  ];

  test("shows each image file there as the file, the others from their data", () => {
    const look = conversationLook(shown, 3, (file) => file === "/p/here.png");
    expect(look.files).toEqual(["image:1", "image:2", "/p/here.png"]);
    expect(look.images).toEqual({ "image:1": A, "image:2": B });
    // The file gone with no data is left out, and the index counts without it.
    expect(look.index).toBe(2);
  });

  test("keeps the one opened, gone or not", () => {
    const look = conversationLook(shown, 1, () => false);
    expect(look.files).toEqual(["image:1", "/p/gone.png", "image:2"]);
    expect(look.index).toBe(1);
  });
});

describe("lookAtImage", () => {
  const shown: ShownImage[] = [{ image: A }, { file: "/p/a.png" }];
  const allThere = async (files: string[]) => new Set(files);

  test("opens at the image among the conversation's", async () => {
    const asked: string[][] = [];
    const look = await lookAtImage(shown, { image: A }, async (files) => {
      asked.push(files);
      return new Set(files);
    });
    expect(look).toEqual({ files: ["image:1", "/p/a.png"], index: 0, images: { "image:1": A } });
    expect(asked).toEqual([["/p/a.png"]]);
  });

  test("puts an image file not among them first", async () => {
    const look = await lookAtImage(shown, { file: "/p/new.png" }, allThere);
    expect(look?.files).toEqual(["/p/new.png", "image:1", "/p/a.png"]);
    expect(look?.index).toBe(0);
  });

  test("is null for an image with no file not among them", async () => {
    expect(await lookAtImage(shown, { image: C }, allThere)).toBeNull();
  });
});

describe("imageFileOf", () => {
  test("is the image file a tool read", () => {
    expect(imageFileOf({ file_path: "/p/shot.png" })).toBe("/p/shot.png");
    expect(imageFileOf({ file_path: "C:\\p\\a.JPG" })).toBe("C:\\p\\a.JPG");
  });

  test("is none for a tool that read no image file", () => {
    expect(imageFileOf({ file_path: "/p/n.ipynb" })).toBeUndefined();
    expect(imageFileOf({ url: "https://example.com" })).toBeUndefined();
    expect(imageFileOf(undefined)).toBeUndefined();
  });
});

test("imageSrc is the image's data URL", () => {
  expect(imageSrc(A)).toBe("data:image/png;base64,AAAA");
});
