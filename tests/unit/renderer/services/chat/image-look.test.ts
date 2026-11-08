/**
 * The images a chat shows open in quick look: one a tool read from an
 * image file as that file, any other from its data, among the images
 * beside it.
 */

import { describe, expect, test } from "bun:test";
import {
  imageFileOf,
  imageLook,
  imageSrc,
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
