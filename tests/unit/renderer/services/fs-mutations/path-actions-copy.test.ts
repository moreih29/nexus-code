import { beforeEach, describe, expect, it } from "bun:test";

const written: string[] = [];
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => {
      written.push(text);
      return Promise.resolve();
    },
  },
});

const { createPathActions } = await import(
  "../../../../../src/renderer/services/fs-mutations/path-actions"
);

function actionsFor(root: string, abs: string) {
  return createPathActions({
    workspaceId: "ws-1",
    workspaceRootPath: root,
    getAbsPath: () => abs,
  });
}

describe("path actions — copy", () => {
  beforeEach(() => {
    written.length = 0;
  });

  it("copies a Windows path with backslashes", () => {
    actionsFor("C:/work/demo", "C:/work/demo/src/main.ts").copyPath();

    expect(written).toEqual(["C:\\work\\demo\\src\\main.ts"]);
  });

  it("copies a POSIX path unchanged", () => {
    actionsFor("/home/me/demo", "/home/me/demo/src/main.ts").copyPath();

    expect(written).toEqual(["/home/me/demo/src/main.ts"]);
  });

  it("copies the relative path against a Windows root", () => {
    actionsFor("C:/work/demo", "C:/work/demo/src/main.ts").copyRelativePath();

    expect(written).toEqual(["src/main.ts"]);
  });
});
