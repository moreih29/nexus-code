import { describe, expect, test } from "bun:test";
import {
  findLinkPlace,
  type LinkPlaceIndex,
  linkPlaceIndex,
  linkPlaces,
  MAX_LINK_PLACES,
} from "../../../../../src/renderer/services/chat/link-places";
import { relativeLinkPath } from "../../../../../src/renderer/services/chat/links";

const ROOT = "/Users/me/work";

function tools(
  ...inputs: Array<[name: string, input: unknown]>
): Record<string, { input: unknown }> {
  return Object.fromEntries(inputs.map(([name, input], i) => [`toolu_${i}`, { name, input }]));
}

function places(target: string, calls = tools(), cwd = ROOT): string[] {
  return linkPlaces(target, linkPlaceIndex(calls, cwd)).map((place) => place.path);
}

describe("relativeLinkPath", () => {
  test("a relative path as written, without its line", () => {
    expect(relativeLinkPath("outputs/a.png", ROOT)).toBe("outputs/a.png");
    expect(relativeLinkPath("src/a.ts:12", ROOT)).toBe("src/a.ts");
    expect(relativeLinkPath("my%20notes.md#L3", ROOT)).toBe("my notes.md");
  });

  test("none for an absolute path, a Windows one, the home folder, or no file", () => {
    expect(relativeLinkPath("/tmp/a.png", ROOT)).toBeNull();
    expect(relativeLinkPath("file:///tmp/a.png", ROOT)).toBeNull();
    expect(relativeLinkPath("C:\\w\\a.ts", ROOT)).toBeNull();
    expect(relativeLinkPath("a.ts", "C:/w")).toBeNull();
    expect(relativeLinkPath("~/a.ts", ROOT)).toBeNull();
    expect(relativeLinkPath("https://example.com/a", ROOT)).toBeNull();
    expect(relativeLinkPath("#top", ROOT)).toBeNull();
  });
});

describe("linkPlaces", () => {
  test("an absolute path is the one place; a link to no file has none", () => {
    const calls = tools(["Bash", { command: "cd /Users/me/work/P" }]);
    expect(places("/tmp/a.png", calls)).toEqual(["/tmp/a.png"]);
    expect(places("file:///tmp/a.png", calls)).toEqual(["/tmp/a.png"]);
    expect(places("https://example.com", calls)).toEqual([]);
  });

  test("a relative link is from the chat's folder first", () => {
    expect(places("./outputs/../a.png")).toEqual([`${ROOT}/a.png`]);
  });

  test("then from where the agent went, the latest first", () => {
    const calls = tools(
      ["Bash", { command: "cd /Users/me/work/old && ls" }],
      ["Bash", { command: "cd tracks/projects/P && python run.py" }],
    );
    expect(places("outputs/bins/b.png", calls)).toEqual([
      `${ROOT}/outputs/bins/b.png`,
      `${ROOT}/tracks/projects/P/outputs/bins/b.png`,
      `${ROOT}/old/outputs/bins/b.png`,
    ]);
  });

  test("a file the agent touched by that path comes before the folders", () => {
    const calls = tools(
      ["Bash", { command: "cd /Users/me/work/tracks/P" }],
      ["Write", { file_path: "/Users/me/work/tracks/Q/outputs/run/vis_eval.py", content: "" }],
    );
    expect(places("outputs/run/vis_eval.py", calls)).toEqual([
      `${ROOT}/outputs/run/vis_eval.py`,
      `${ROOT}/tracks/Q/outputs/run/vis_eval.py`,
      `${ROOT}/tracks/P/outputs/run/vis_eval.py`,
    ]);
  });

  test("cd chains, quotes, the home folder, and Codex's word lists", () => {
    const calls = tools(
      ["Bash", { command: 'cd "/Users/me/work/a b" && cd c; cd ~/x; cd $DIR; cd -' }],
      ["shell", { command: ["bash", "-lc", "cd /Users/me/work/codex && make"] }],
    );
    expect(places("f.txt", calls)).toEqual([
      `${ROOT}/f.txt`,
      `${ROOT}/codex/f.txt`,
      "/Users/me/x/f.txt",
      `${ROOT}/a b/c/f.txt`,
      `${ROOT}/a b/f.txt`,
    ]);
  });

  test("a Codex command goes from the folder it ran in", () => {
    const calls = tools(["Bash", { command: "cd out && make", cwd: "/Users/me/work/P" }]);
    expect(places("a.png", calls)).toEqual([
      `${ROOT}/a.png`,
      `${ROOT}/P/out/a.png`,
      `${ROOT}/P/a.png`,
    ]);
  });

  test("a link keeps its line, and a path that leaves its folder leaves each", () => {
    const calls = tools(["Bash", { command: "cd /Users/me/work/P/src" }]);
    const [first, there] = linkPlaces("a.ts:12:3", linkPlaceIndex(calls, ROOT));
    expect(first).toEqual({
      path: `${ROOT}/a.ts`,
      line: 12,
      column: 3,
      literal: `${ROOT}/a.ts:12:3`,
    });
    expect(there).toEqual({
      path: `${ROOT}/P/src/a.ts`,
      line: 12,
      column: 3,
      literal: `${ROOT}/P/src/a.ts:12:3`,
    });
    expect(places("../out/a.png", calls)).toEqual(["/Users/me/out/a.png", `${ROOT}/P/out/a.png`]);
  });

  test("a name that only ends like the link is not taken for it", () => {
    const calls = tools(["Read", { file_path: "/Users/me/work/xoutputs/a.png" }]);
    expect(places("outputs/a.png", calls)).toEqual([`${ROOT}/outputs/a.png`]);
  });

  test("a Windows folder looks only in itself", () => {
    const calls = tools(["Bash", { command: "cd C:/w/p" }], ["Read", { file_path: "/x/a.ts" }]);
    expect(places("a.ts", calls, "C:/w")).toEqual(["C:/w/a.ts"]);
  });

  test("a long conversation gives a few places, not all", () => {
    const calls = tools(
      ...Array.from({ length: 20 }, (_, i): [string, unknown] => [
        "Bash",
        { command: `cd /d${i}` },
      ]),
    );
    expect(places("a.png", calls)).toHaveLength(MAX_LINK_PLACES);
    expect(places("a.png", calls)[1]).toBe("/d19/a.png");
  });

  test("the index keeps each file and folder once, the latest first", () => {
    const index: LinkPlaceIndex = linkPlaceIndex(
      tools(
        ["Bash", { command: "cd /a && cd /b" }],
        ["Read", { file_path: "/x//y/../z.ts" }],
        ["Bash", { command: "cd /a" }],
        ["Grep", { path: "relative/dir", pattern: "x" }],
      ),
      ROOT,
    );
    expect(index).toEqual({ cwd: ROOT, files: ["/x/z.ts"], folders: ["/a", "/b"] });
  });
});

describe("findLinkPlace", () => {
  const link = (path: string, literal?: string) => ({ path, ...(literal ? { literal } : {}) });

  test("the first place with a file, by its path or its path with the line", async () => {
    const there = new Set(["/b", "/c:3"]);
    const has = async (paths: string[]) => new Set(paths.filter((p) => there.has(p)));
    expect(await findLinkPlace([link("/a"), link("/b"), link("/c")], has)).toEqual(link("/b"));
    expect(await findLinkPlace([link("/a", "/a:3"), link("/c", "/c:3")], has)).toEqual(
      link("/c", "/c:3"),
    );
  });

  test("the first place when none has one, or the computer can't be asked", async () => {
    expect(await findLinkPlace([link("/a"), link("/b")], async () => new Set())).toEqual(
      link("/a"),
    );
    expect(
      await findLinkPlace([link("/a"), link("/b")], async () => {
        throw new Error("offline");
      }),
    ).toEqual(link("/a"));
  });

  test("one place is not looked for, and no place is none", async () => {
    let asked = false;
    const ask = async () => {
      asked = true;
      return new Set<string>();
    };
    expect(await findLinkPlace([link("/a")], ask)).toEqual(link("/a"));
    expect(await findLinkPlace([], ask)).toBeNull();
    expect(asked).toBe(false);
  });
});
