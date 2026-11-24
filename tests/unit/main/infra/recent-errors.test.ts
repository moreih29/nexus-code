import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import {
  BugReportRecentErrorSchema,
  cleanBugReportErrorMessage,
  MAX_BUG_REPORT_ERROR_AGE,
  redactBugReportText,
} from "../../../../packages/remote-protocol/src";
import { homeRedactor, RecentErrors } from "../../../../src/main/infra/recent-errors";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("recent errors", () => {
  test("keeps the last 20, newest first", () => {
    const time = clock();
    const errors = new RecentErrors(time.now);
    for (let n = 0; n < 25; n++) {
      errors.record("api", `http_${500 + n}`, 500 + n);
      time.advance(1000);
    }
    const list = errors.list();
    expect(list).toHaveLength(20);
    expect(list[0]).toEqual({ ago: 1, area: "api", code: "http_524", status: 524 });
    expect(list.at(-1)).toEqual({ ago: 20, area: "api", code: "http_505", status: 505 });
  });

  test("says how long ago each happened when asked, in whole seconds", () => {
    const time = clock();
    const errors = new RecentErrors(time.now);
    errors.record("relay", "socket-closed");
    time.advance(1_500);
    errors.record("push", "timeout");
    time.advance(41_900);
    expect(errors.list()).toEqual([
      { ago: 41, area: "push", code: "timeout" },
      { ago: 43, area: "relay", code: "socket-closed" },
    ]);
    time.advance(60_000);
    expect(errors.list().map((e) => e.ago)).toEqual([101, 103]);
    for (const entry of errors.list()) BugReportRecentErrorSchema.parse(entry);
  });

  test("leaves out what is older than the schema takes", () => {
    const time = clock();
    const errors = new RecentErrors(time.now);
    errors.record("api", "offline");
    time.advance(MAX_BUG_REPORT_ERROR_AGE * 1000 + 1000);
    errors.record("api", "timeout");
    expect(errors.list()).toEqual([{ ago: 0, area: "api", code: "timeout" }]);
  });

  test("takes only a valid code and only a real HTTP status", () => {
    const errors = new RecentErrors(clock().now);
    errors.record("api", "ENOENT: no such file /Users/someone/project");
    errors.record("api", "HTTP_500");
    errors.record("api", "x".repeat(41));
    errors.record("api", "");
    errors.record("api", "http_999", 999);
    errors.record("relay", "rate-limited", 429.5);
    expect(errors.list()).toEqual([
      { ago: 0, area: "relay", code: "rate-limited" },
      { ago: 0, area: "api", code: "http_999" },
    ]);
  });

  test("redacts a message as it records it and keeps it to one short line", () => {
    const errors = new RecentErrors(clock().now);
    errors.record(
      "files",
      "read:not_found",
      undefined,
      "ENOENT: no such file or directory, open 'C:\\Users\\kim\\a.txt'\n    at x (/Users/kim/app.js:1:2)",
    );
    errors.record("app", "uncaught:error", undefined, "x".repeat(500));
    errors.record("app", "blank", undefined, " \n ");
    const [blank, long, files] = errors.list();
    expect(files?.message).toBe("ENOENT: no such file or directory, open '<path>' at x (<path>)");
    expect(Array.from(long?.message ?? "")).toHaveLength(300);
    expect(blank).toEqual({ ago: 0, area: "app", code: "blank" });
    for (const entry of errors.list()) BugReportRecentErrorSchema.parse(entry);
  });

  test("puts a repeated error together: one entry, counted, at its last time", () => {
    const time = clock();
    const errors = new RecentErrors(time.now);
    errors.record("files", "read:not_found", undefined, "open '/Users/a/x'");
    time.advance(5_000);
    errors.record("api", "offline");
    time.advance(5_000);
    errors.record("files", "read:not_found", undefined, "open '/Users/b/y'");
    errors.record("files", "read:not_found", undefined, "another message");
    expect(errors.list()).toEqual([
      { ago: 0, area: "files", code: "read:not_found", message: "another message" },
      { ago: 0, area: "files", code: "read:not_found", message: "open '<path>'", count: 2 },
      { ago: 5, area: "api", code: "offline" },
    ]);
  });

  test("a storm of one error leaves the others in place", () => {
    const time = clock();
    const errors = new RecentErrors(time.now);
    for (let n = 0; n < 19; n++) errors.record("api", `http_${500 + n}`, 500 + n);
    for (let n = 0; n < 20_000; n++) errors.record("app", "renderer:type_error");
    const list = errors.list();
    expect(list).toHaveLength(20);
    expect(list[0]).toEqual({ ago: 0, area: "app", code: "renderer:type_error", count: 9999 });
    expect(list.at(-1)?.code).toBe("http_500");
  });

  test("keeps them in memory only: nothing is written, and a new start has none", () => {
    const writes = [
      spyOn(fs, "writeFileSync"),
      spyOn(fs, "appendFileSync"),
      spyOn(fs, "createWriteStream"),
      spyOn(fsp, "writeFile"),
      spyOn(fsp, "appendFile"),
    ];
    try {
      const errors = new RecentErrors(clock().now);
      for (let n = 0; n < 30; n++) errors.record("api", "offline");
      errors.list();
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(new RecentErrors(clock().now).list()).toEqual([]);
    } finally {
      for (const write of writes) write.mockRestore();
    }
  });
});

describe("this computer's home folder in a recorded message", () => {
  const QA_HOME = "C:\\tmp\\QA\\John Smith";
  const recorded = (home: string, message: string) => {
    const errors = new RecentErrors(clock().now, 20, homeRedactor(home));
    errors.record("app", "x", undefined, message);
    return errors.list()[0]?.message;
  };

  test("goes whole, where the shared rules would leave a word of a name outside \\Users\\", () => {
    expect(recorded(QA_HOME, "cannot access C:\\tmp\\QA\\John Smith")).toBe("cannot access <path>");
    expect(recorded(QA_HOME, "C:\\tmp\\QA\\John Smith was not found")).toBe("<path> was not found");
    expect(recorded(QA_HOME, "C:\\tmp\\QA\\John Smith.")).toBe("<path>.");
    expect(recorded("D:\\home\\A B C D\\", "open D:\\home\\A B C D now")).toBe("open <path> now");
    expect(recorded("/srv/people/kim lee", "stat /srv/people/kim lee")).toBe("stat <path>");
    expect(recorded("C:\\tmp\\a+b (x)", "C:\\tmp\\a+b (x) failed")).toBe("<path> failed");
  });

  test("in either slash, JSON's doubled backslashes, a long path and any case", () => {
    expect(recorded(QA_HOME, "c:/TMP/qa/john smith: denied")).toBe("<path>: denied");
    expect(recorded(QA_HOME, '{"p":"C:\\\\tmp\\\\QA\\\\John Smith"}')).toBe('{"p":"<path>"}');
    expect(recorded(QA_HOME, "open \\\\?\\C:\\tmp\\QA\\John Smith")).toBe("open <path>");
  });

  test("and the path it starts go whole, however many spaces the name has", () => {
    expect(recorded(QA_HOME, "C:\\tmp\\QA\\John Smith\\Documents\\final report.txt")).toBe(
      "<path>",
    );
    expect(recorded(QA_HOME, '{"p":"C:\\\\tmp\\\\QA\\\\John Smith\\\\a b c\\\\x y z"}')).toBe(
      '{"p":"<path>"}',
    );
    expect(recorded("D:\\home\\A B C D", "D:\\home\\A B C D\\x\\y.txt")).toBe("<path>");
    expect(recorded("/srv/people/kim lee", "x /srv/people/kim lee/a/b")).toBe("x <path>");
    expect(recorded(QA_HOME, "load file:///C:/tmp/QA/John Smith/a.html")).toBe("load <path>");
  });

  test("is left to the shared rules when the name goes on: another folder", () => {
    const forget = homeRedactor("/Users/kim");
    expect(forget("/Users/kimberly/x")).toBe("/Users/kimberly/x");
    expect(forget("/Users/kim_2")).toBe("/Users/kim_2");
    expect(forget("/Users/kim.bak/x")).toBe("/Users/kim.bak/x");
    expect(recorded("/Users/kim", "open /Users/kimberly/x now")).toBe("open <path> now");
  });

  test("changes nothing for a root, a share or an empty home", () => {
    for (const home of ["", "/", "C:\\", "C:", "\\\\srv\\share\\kim", "relative\\kim"]) {
      expect(homeRedactor(home)("cannot access C:\\a b /x y \\\\srv\\share\\kim")).toBe(
        "cannot access C:\\a b /x y \\\\srv\\share\\kim",
      );
    }
  });

  test("by default is the home of the computer the app runs on", () => {
    const errors = new RecentErrors(clock().now);
    errors.record("app", "x", undefined, `open ${homedir()} failed`);
    expect(errors.list()[0]?.message).toBe("open <path> failed");
  });

  test("a recorded message comes out the same from the shared rules", () => {
    for (const message of [
      "cannot access C:\\tmp\\QA\\John Smith",
      "C:\\tmp\\QA\\John Smith\\Documents\\final report.txt",
      "c:/TMP/qa/john smith: denied",
    ]) {
      const shown = recorded(QA_HOME, message);
      expect(shown).toBeDefined();
      expect(cleanBugReportErrorMessage(shown ?? "")).toBe(shown);
      expect(redactBugReportText(shown ?? "")).toBe(shown);
    }
  });
});
