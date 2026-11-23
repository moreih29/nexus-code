import { describe, expect, test } from "bun:test";
import {
  isUnder,
  relativeTo,
  shownPath,
  slashWindowsPath,
} from "../../../src/shared/fs/relative-path";

describe("relativeTo", () => {
  test("a POSIX path inside its folder, with or without a trailing slash", () => {
    expect(relativeTo("/w/proj/src/a.ts", "/w/proj")).toBe("src/a.ts");
    expect(relativeTo("/w/proj/src/a.ts", "/w/proj/")).toBe("src/a.ts");
    expect(relativeTo("/w/proj", "/w/proj")).toBe("");
    expect(relativeTo("/w/proj/a.ts", "/")).toBe("w/proj/a.ts");
  });

  test("POSIX keeps case and the prefix trap", () => {
    expect(relativeTo("/W/proj/a.ts", "/w/proj")).toBe("/W/proj/a.ts");
    expect(relativeTo("/w/project/a.ts", "/w/proj")).toBe("/w/project/a.ts");
  });

  test("Windows backslashes and either drive case land on the same slashed path", () => {
    expect(relativeTo("C:\\w\\proj\\src\\a.ts", "C:\\w\\proj")).toBe("src/a.ts");
    expect(relativeTo("c:\\W\\Proj\\src\\a.ts", "C:/w/proj/")).toBe("src/a.ts");
    expect(relativeTo("C:/w/proj/src/a.ts", "c:\\w\\proj")).toBe("src/a.ts");
    expect(relativeTo("\\\\server\\share\\app\\src\\a.ts", "//SERVER/share/app")).toBe("src/a.ts");
  });

  test("a path outside comes back as written", () => {
    expect(relativeTo("D:\\other\\b.ts", "C:\\w\\proj")).toBe("D:\\other\\b.ts");
    expect(relativeTo("/tmp/x", "/w/proj")).toBe("/tmp/x");
    expect(relativeTo("/tmp/x", "")).toBe("/tmp/x");
  });
});

describe("shownPath", () => {
  test("the folder itself shows as written, not empty", () => {
    expect(shownPath("C:\\w\\proj", "C:/w/proj")).toBe("C:\\w\\proj");
    expect(shownPath("/w/proj/a.ts", "/w/proj")).toBe("a.ts");
  });
});

describe("isUnder", () => {
  test("matches relativeTo's rules", () => {
    expect(isUnder("/w/a.ts", "/w")).toBe(true);
    expect(isUnder("/w", "/w/")).toBe(true);
    expect(isUnder("/wx/a.ts", "/w")).toBe(false);
    expect(isUnder("/W/a.ts", "/w")).toBe(false);
    expect(isUnder("c:\\W\\a.ts", "C:/w")).toBe(true);
    expect(isUnder("/a.ts", "/")).toBe(true);
    expect(isUnder("/a.ts", "")).toBe(false);
    expect(isUnder("", "/w")).toBe(false);
  });
});

describe("slashWindowsPath", () => {
  test("drive and UNC paths get slashes, the drive upper case; POSIX stays", () => {
    expect(slashWindowsPath("c:\\w\\a.ts")).toBe("C:/w/a.ts");
    expect(slashWindowsPath("\\\\server\\share\\a.ts")).toBe("//server/share/a.ts");
    expect(slashWindowsPath("/w/a\\b.ts")).toBe("/w/a\\b.ts");
  });
});
