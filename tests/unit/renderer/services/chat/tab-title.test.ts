import { describe, expect, test } from "bun:test";
import {
  shortenPaths,
  TITLE_CHARS,
  titleOf,
} from "../../../../../src/renderer/services/chat/tab-title";

const PATHS: readonly (readonly [string, string, string])[] = [
  [
    "macOS absolute path",
    "/Users/demo/projects/briefs/status-qa.md 를 읽고 진행해 주세요",
    "status-qa.md 를 읽고 진행해 주세요",
  ],
  ["Linux absolute path", "/home/dev/app/src/main.rs 고쳐 주세요", "main.rs 고쳐 주세요"],
  ["root folder", "/tmp/brief.md 를 읽고", "brief.md 를 읽고"],
  [
    "from home, particle attached",
    "~/notes/qa-brief.md를 읽어 주세요",
    "qa-brief.md를 읽어 주세요",
  ],
  ["from home, one separator", "~/brief.md 정리", "brief.md 정리"],
  ["from here", "./scripts/build.sh 실행", "build.sh 실행"],
  ["from the parent", "../shared/types.ts 확인", "types.ts 확인"],
  [
    "Windows backslashes",
    "C:\\Users\\demo\\AppData\\Local\\Temp\\qa-brief.md 를 읽고",
    "qa-brief.md 를 읽고",
  ],
  ["Windows forward slashes", "C:/Users/demo/work/report.xlsx 정리", "report.xlsx 정리"],
  ["Git Bash", "/c/Users/demo/AppData/Local/Temp/qa-brief.md 를 읽고", "qa-brief.md 를 읽고"],
  ["one-part command", "/review 해 주세요", "/review 해 주세요"],
  ["command with a short path", "/review src/app.ts", "/review src/app.ts"],
  ["short route", "GET /api/status 응답 확인", "GET /api/status 응답 확인"],
  [
    "address",
    "https://github.com/acme/app/pull/12 리뷰",
    "https://github.com/acme/app/pull/12 리뷰",
  ],
  ["relative path with a file", "src/renderer/app.tsx 고쳐", "app.tsx 고쳐"],
  ["words with slashes", "읽기/쓰기/실행 권한 정리", "읽기/쓰기/실행 권한 정리"],
  ["date", "2026/11/23 회의록", "2026/11/23 회의록"],
  ["space in a folder", "/Users/demo/My Documents/brief.md 를 읽고", "brief.md 를 읽고"],
  ["space on Windows", "C:\\Program Files\\Acme\\run.log 확인", "run.log 확인"],
  ["quoted with a space", '"/Users/demo/My Docs/brief.md" 읽기', '"brief.md" 읽기'],
  ["in backticks", "`/Users/demo/a.md` 확인", "`a.md` 확인"],
  ["in parentheses", "결과(/Users/demo/out/report.md) 확인", "결과(report.md) 확인"],
  ["opening a parenthesis", "결과 (/Users/demo/out/report.md) 확인", "결과 (report.md) 확인"],
  ["two paths", "/Users/demo/a.md /Users/demo/b.md 비교", "a.md b.md 비교"],
  ["folder", "/Users/demo/projects/ 정리", "projects 정리"],
];

describe("shortenPaths", () => {
  test.each(PATHS)("%s", (_case, input, output) => {
    expect(shortenPaths(input)).toBe(output);
  });

  test.each(PATHS)("%s, shortened again, stays", (_case, _input, output) => {
    expect(shortenPaths(output)).toBe(output);
  });
});

describe("titleOf", () => {
  test("a brief's path reads as its file name before the sentence is cut", () => {
    expect(titleOf("/tmp/delegate/agent-list-a.md 를 읽고 그대로 진행해 주세요.")).toBe(
      "agent-list-a.md 를 읽고 그대로 진행해 주세요",
    );
    expect(
      titleOf(
        "작업 지시서 /c/Users/demo/AppData/Local/Temp/qa-brief.md 를 읽고 그대로 진행해 주세요\n\n둘째 줄",
      ),
    ).toBe("작업 지시서 qa-brief.md 를 읽고 그대로 진행해 주세요");
  });

  test("a path's dots do not end the sentence, and the title is still cut to length", () => {
    expect(titleOf("~/notes/v1.2/brief.md 읽기. 그다음 정리")).toBe("brief.md 읽기");
    const long = `/Users/demo/${"x".repeat(80)}.md 읽기`;
    expect(titleOf(long)).toHaveLength(TITLE_CHARS);
    expect(titleOf(long).endsWith("…")).toBe(true);
  });
});
