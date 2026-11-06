import { describe, expect, test } from "bun:test";
import {
  baseName,
  fileKind,
  isLocalAddress,
  isUnder,
  resolveFilePath,
  resultFiles,
  slashWindowsPath,
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

  test("a Windows path comes back with slashes, its drive in front", () => {
    const cwd = "C:/w/proj";
    expect(resolveFilePath("C:\\w\\proj\\src\\a.ts", cwd)).toBe("C:/w/proj/src/a.ts");
    expect(resolveFilePath("C:/w/proj/src/a.ts#L2", cwd)).toBe("C:/w/proj/src/a.ts");
    expect(resolveFilePath("D:\\other\\b.txt", cwd)).toBe("D:/other/b.txt");
    expect(resolveFilePath("src\\a.ts", cwd)).toBe("C:/w/proj/src/a.ts");
    expect(resolveFilePath("src/a.ts", `${cwd}/`)).toBe("C:/w/proj/src/a.ts");
    expect(resolveFilePath("..\\b\\c.md", cwd)).toBe("C:/w/b/c.md");
    expect(resolveFilePath("file:///C:/w/a%20b.txt", "/w")).toBe("C:/w/a b.txt");
    // A markdown link's href, its `\` escaped.
    expect(resolveFilePath("C:%5Cw%5Cproj%5Ca.ts", "/w")).toBe("C:/w/proj/a.ts");
    expect(resolveFilePath("src%5Ca.ts", cwd)).toBe("C:/w/proj/src/a.ts");
    // A backslash is only a separator where the session runs on Windows.
    expect(resolveFilePath("a\\b.txt", "/w")).toBe("/w/a\\b.txt");
  });

  test("a Windows path written with slashes", () => {
    expect(slashWindowsPath("C:\\w\\a.ts")).toBe("C:/w/a.ts");
    expect(slashWindowsPath("C:/w/a.ts")).toBe("C:/w/a.ts");
    expect(slashWindowsPath("/w/a\\b.ts")).toBe("/w/a\\b.ts");
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
    expect(isUnder("C:/w/a.ts", "C:/w")).toBe(true);
    expect(isUnder("C:\\w\\a.ts", "C:/w/")).toBe(true);
    expect(isUnder("c:/W/a.ts", "C:/w")).toBe(true);
    expect(isUnder("C:/wx/a.ts", "C:/w")).toBe(false);
    expect(isUnder("C:/a.ts", "C:/")).toBe(true);
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
