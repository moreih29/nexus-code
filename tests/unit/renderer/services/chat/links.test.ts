import { describe, expect, test } from "bun:test";
import {
  baseName,
  fileKind,
  isLocalAddress,
  isUnder,
  resolveFilePath,
  resultFiles,
} from "../../../../../src/renderer/services/chat/links";

describe("chat links", () => {
  test("a path resolves against the session's folder", () => {
    expect(resolveFilePath("src/a.ts", "/w/proj")).toBe("/w/proj/src/a.ts");
    expect(resolveFilePath("./a.ts", "/w/proj/")).toBe("/w/proj/a.ts");
    expect(resolveFilePath("../b/c.md", "/w/proj")).toBe("/w/b/c.md");
    expect(resolveFilePath("/tmp/out.png", "/w/proj")).toBe("/tmp/out.png");
    expect(resolveFilePath("/tmp//x/./y.txt", "/w")).toBe("/tmp/x/y.txt");
  });

  test("a link's line, anchor and escapes are left out", () => {
    expect(resolveFilePath("src/a.ts#L10", "/w")).toBe("/w/src/a.ts");
    expect(resolveFilePath("my%20notes.md", "/w")).toBe("/w/my notes.md");
    expect(resolveFilePath("file:///tmp/a%20b.txt", "/w")).toBe("/tmp/a b.txt");
  });

  test("what is not a file path resolves to nothing", () => {
    expect(resolveFilePath("https://example.com/a.ts", "/w")).toBeNull();
    expect(resolveFilePath("javascript:alert(1)", "/w")).toBeNull();
    expect(resolveFilePath("~/notes.md", "/w")).toBeNull();
    expect(resolveFilePath("  ", "/w")).toBeNull();
  });

  test("the results that are files, each once", () => {
    const files = resultFiles(
      [
        { kind: "file", target: "/w/out.md", created: true },
        { kind: "url", target: "http://localhost:3000", created: false },
        { kind: "file", target: "out.md", created: false },
        { kind: "file", target: "docs/a.pdf", created: false },
      ],
      "/w",
    );
    expect(files).toEqual(["/w/out.md", "/w/docs/a.pdf"]);
  });

  test("under a root", () => {
    expect(isUnder("/w/a.ts", "/w")).toBe(true);
    expect(isUnder("/w/a.ts", "/w/")).toBe(true);
    expect(isUnder("/wx/a.ts", "/w")).toBe(false);
    expect(isUnder("/tmp/a.ts", "")).toBe(false);
  });

  test("the machine's own addresses", () => {
    expect(isLocalAddress("http://localhost:5173/")).toBe(true);
    expect(isLocalAddress("http://app.localhost/")).toBe(true);
    expect(isLocalAddress("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalAddress("http://[::1]:3000")).toBe(true);
    expect(isLocalAddress("http://0.0.0.0:3000")).toBe(true);
    expect(isLocalAddress("https://example.com")).toBe(false);
    expect(isLocalAddress("http://localhost.example.com")).toBe(false);
    expect(isLocalAddress("file:///tmp/a")).toBe(false);
    expect(isLocalAddress("not a url")).toBe(false);
  });

  test("a file's kind and name", () => {
    expect(fileKind("/a/shot.png")).toBe("image");
    expect(fileKind("/a/logo.svg")).toBe("image");
    expect(fileKind("/a/clip.mp4")).toBe("video");
    expect(fileKind("/a/report.pdf")).toBe("pdf");
    expect(fileKind("/a/data.csv")).toBe("data");
    expect(fileKind("/a/README.md")).toBe("page");
    expect(fileKind("/a/main.go")).toBe("code");
    expect(fileKind("/a/notes.txt")).toBe("text");
    expect(fileKind("/a/dir/")).toBe("folder");
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(baseName("/a/b/")).toBe("b");
  });
});
