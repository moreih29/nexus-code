import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import {
  rememberPickedNetworkFile,
  restorePickedNetworkFiles,
} from "../../../../../src/main/features/fs/outside-grants";
import {
  openPathExternalHandler,
  revealInOSHandler,
} from "../../../../../src/main/features/shell/open-path";

const WINDOWS = process.platform === "win32";

afterEach(() => restorePickedNetworkFiles([], [], () => {}));

function setup(roots: readonly string[] = []) {
  const access = spyOn(fs.promises, "access").mockResolvedValue(undefined);
  const shell = {
    openPath: mock(async (_path: string) => ""),
    showItemInFolder: mock((_path: string) => {}),
    trashItem: mock(async (_path: string) => {}),
  };
  const open = openPathExternalHandler(shell, () => roots);
  const reveal = revealInOSHandler(shell, () => roots);
  const both = async (absPath: string) => [await open({ absPath }), await reveal({ absPath })];
  return { access, shell, both };
}

const NOT_FOUND = { ok: false, error: expect.objectContaining({ code: "not-found" }) };

describe.if(WINDOWS)("opening or revealing a path in Windows", () => {
  test("touches no share or device path before deciding", async () => {
    const { access, shell, both } = setup(["C:/w"]);
    try {
      for (const absPath of [
        String.raw`\\h.example\s\a.txt`,
        "//h.example/s/a.txt",
        String.raw`/\h.example\s\a.txt`,
        String.raw`\\?\UNC\h.example\s\a.txt`,
        String.raw`\??\UNC\h.example\s\a.txt`,
        "/??/UNC/h.example/s/a.txt",
        String.raw`\\.\C:\a.txt`,
        String.raw`\\?\C:\a.txt`,
      ]) {
        expect([absPath, await both(absPath)]).toEqual([absPath, [NOT_FOUND, NOT_FOUND]]);
      }
      expect(access).not.toHaveBeenCalled();
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();

      expect(await both("C:/w/a.txt")).toEqual([{ ok: true }, { ok: true }]);
      expect(access).toHaveBeenCalledTimes(2);
    } finally {
      access.mockRestore();
    }
  });

  test("takes a share file the user picked", async () => {
    const picked = String.raw`\\h.example\s\picked.txt`;
    rememberPickedNetworkFile(picked);
    const { access, shell, both } = setup();
    try {
      expect(await both("//H.EXAMPLE/s/picked.txt")).toEqual([{ ok: true }, { ok: true }]);
      expect(await both("//h.example/s/other.txt")).toEqual([NOT_FOUND, NOT_FOUND]);
      expect(access.mock.calls.map(([path]) => path)).toEqual([picked, picked]);
      expect(shell.openPath.mock.calls).toEqual([[picked]]);
      expect(shell.showItemInFolder.mock.calls).toEqual([[picked]]);
    } finally {
      access.mockRestore();
    }
  });

  test("takes a file on the share of an open local workspace", async () => {
    const { access, shell, both } = setup(["C:/w", "//nas/Share/repo"]);
    try {
      expect(await both("//NAS/share/repo/src/a.ts")).toEqual([{ ok: true }, { ok: true }]);
      expect(await both("//nas/other/a.ts")).toEqual([NOT_FOUND, NOT_FOUND]);
      expect(await both(String.raw`\\?\UNC\nas\Share\repo\a.ts`)).toEqual([NOT_FOUND, NOT_FOUND]);
      const opened = String.raw`\\NAS\share\repo\src\a.ts`;
      expect(access.mock.calls.map(([path]) => path)).toEqual([opened, opened]);
      expect(shell.showItemInFolder.mock.calls).toEqual([[opened]]);
    } finally {
      access.mockRestore();
    }
  });
});

describe.if(!WINDOWS)("opening or revealing a path elsewhere", () => {
  test("is as it was for a path that starts with two slashes", async () => {
    const { access, both } = setup();
    try {
      expect(await both("//h/s/a.txt")).toEqual([{ ok: true }, { ok: true }]);
      expect(access).toHaveBeenCalledTimes(2);
    } finally {
      access.mockRestore();
    }
  });
});
