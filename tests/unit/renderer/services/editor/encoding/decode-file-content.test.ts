/**
 * What the editor reads: UTF-8 as the agent sent it, and the bytes of text
 * in any other encoding decoded in the one it is most likely in, or in the
 * one the user reopened the file in.
 */
import { expect, test } from "bun:test";

(globalThis as Record<string, unknown>).window ??= {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
};

const { decodeFileContent } = await import(
  "../../../../../../src/renderer/services/editor/model/file-loader"
);

const read = { sizeBytes: 4, isBinary: false, mtime: "T" };

test("UTF-8 comes through as it was read", () => {
  expect(decodeFileContent({ ...read, content: "hi", encoding: "utf8" })).toEqual({
    ...read,
    content: "hi",
    encoding: "utf8",
  });
});

test("bytes are decoded in the encoding they are valid in", () => {
  // "café" in Windows-1252, which takes any bytes.
  const latin = decodeFileContent({ ...read, content: "", encoding: "bytes", bytes: "Y2Fm6Q==" });
  expect(latin).toEqual({ ...read, content: "café", encoding: "windows-1252" });
  // UTF-16 LE by its byte-order mark.
  const utf16 = decodeFileContent({ ...read, content: "", encoding: "bytes", bytes: "//5oAGkA" });
  expect(utf16).toMatchObject({ content: "hi", encoding: "utf-16le" });
});

test("a file reopened in an encoding is read in it, UTF-8 too", () => {
  // C7 D1 B1 DB: "한글" in EUC-KR.
  const korean = decodeFileContent(
    { ...read, content: "", encoding: "bytes", bytes: "x9Gx2w==" },
    "euc-kr",
  );
  expect(korean).toMatchObject({ content: "한글", encoding: "euc-kr" });
  // "é" in UTF-8 (C3 A9), reopened as Windows-1252.
  const utf8 = decodeFileContent({ ...read, content: "é", encoding: "utf8" }, "windows-1252");
  expect(utf8).toMatchObject({ content: "Ã©", encoding: "windows-1252" });
});
