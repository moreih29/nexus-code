import { expect, test } from "bun:test";
import { toolSummary } from "../../../../../src/renderer/components/chat/tool-row";
import type { ToolCall } from "../../../../../src/renderer/services/chat/model";
import { shownPath } from "../../../../../src/shared/fs/relative-path";

const cases: [string, string][] = [
  ["/w/proj/src/a.ts", "/w/proj"],
  ["/w/proj/src/a.ts", "/w/proj/"],
  ["C:\\w\\proj\\src\\a.ts", "C:\\w\\proj"],
  ["c:\\W\\Proj\\src\\a.ts", "C:/w/proj"],
  ["\\\\server\\share\\app\\a.ts", "//server/share/app"],
  ["D:\\other\\b.ts", "C:\\w\\proj"],
  ["/tmp/x", "/w/proj"],
];

test.each(
  cases,
)("a tool row and the side panel shorten %s against %s the same way", (path, cwd) => {
  const tool = { name: "Read", input: { file_path: path } } as unknown as ToolCall;
  expect(toolSummary(tool, cwd)).toBe(shownPath(path, cwd));
});
