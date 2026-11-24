import { describe, expect, test } from "bun:test";
import {
  BUG_REPORT_ERROR_CODE_PATTERN,
  BUG_REPORT_OS_VERSION_PATTERN,
  BugReportContextSchema,
  BugReportSchema,
  bugReportBytes,
  MAX_BUG_REPORT_CONTEXT_BYTES,
  MAX_BUG_REPORT_DESCRIPTION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "../../../../packages/remote-protocol/src";
import {
  bugReportContext,
  bugReportErrorCode,
  bugReportFits,
  bugReportLength,
  bugReportLocale,
  bugReportOsVersion,
  buildBugReport,
  cleanBugReportDescription,
  errorMessageOf,
  errorNameOf,
  ReportedErrorSchema,
} from "../../../../src/shared/remote/bug-report";

const ID = "6f1c1f5e-3a0b-4c55-9a43-0f3f5b8a9e21";
const MAC = { appVersion: "1.4.0", osVersion: "25.1.0", arch: "arm64" };

describe("a bug report's description", () => {
  test("sends Windows line breaks as \\n and drops other control characters", () => {
    expect(cleanBugReportDescription("first line\r\nsecond\tline\u0000\u0007\u001b[31m\r")).toBe(
      "first line\nsecond\tline[31m",
    );
  });

  test("drops a lone surrogate and keeps a pair", () => {
    expect(cleanBugReportDescription("crash \uD83D here 😀")).toBe("crash  here 😀");
  });

  test("counts code points, as the server does", () => {
    expect(bugReportLength("😀".repeat(10))).toBe(10);
    expect(bugReportFits("😀".repeat(10))).toBe(true);
    expect(bugReportFits(`  short\u0000\u0001  `)).toBe(false);
    expect(bugReportFits("x".repeat(MAX_BUG_REPORT_DESCRIPTION))).toBe(true);
    expect(bugReportFits("x".repeat(MAX_BUG_REPORT_DESCRIPTION + 1))).toBe(false);
  });
});

describe("the request body", () => {
  test("passes the protocol schema with \\r\\n and control characters in the description", () => {
    const context = bugReportContext(MAC, "ko", [
      { ago: 42, area: "api", code: "http_500", status: 500 },
      { ago: 3, area: "relay", code: "socket-closed" },
    ]);
    const body = buildBugReport(
      ID,
      {
        description: "The terminal froze\r\nafter I pasted\u0000\u001f\u007f\u0085 text.",
        contactOk: true,
      },
      context,
    );
    expect(BugReportSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      id: ID,
      description: "The terminal froze\nafter I pasted text.",
      contactOk: true,
      context: {
        app: { version: "1.4.0" },
        os: { version: "25.1.0" },
        device: { kind: "desktop", arch: "arm64" },
        protocol: { version: PROTOCOL_VERSION, package: SCHEMA_VERSION },
        locale: "ko",
        errors: [
          { ago: 42, area: "api", code: "http_500", status: 500 },
          { ago: 3, area: "relay", code: "socket-closed" },
        ],
      },
    });
  });

  test.each([
    ["Windows", { appVersion: "1.4.0-beta.2", osVersion: "10.0.26100", arch: "x64" }],
    ["WSL", { appVersion: "1.4.0", osVersion: "5.15.153.1-microsoft-standard-WSL2", arch: "x64" }],
    ["an odd release", { appVersion: "1.4.0 (dev)", osVersion: "6.8.0 #1 SMP", arch: "ARM 64" }],
    ["an empty release", { appVersion: "", osVersion: "", arch: "" }],
  ])("fits what %s reports to the schema", (_name, facts) => {
    const body = buildBugReport(
      ID,
      { description: "Ten or more characters", contactOk: false },
      bugReportContext(facts, "en", null),
    );
    expect(BugReportSchema.safeParse(body).success).toBe(true);
  });

  test("leaves out an arch the schema refuses and never names a model", () => {
    const context = bugReportContext({ ...MAC, arch: "ARM 64" }, "en", []);
    expect(context.device).toEqual({ kind: "desktop" });
    expect(context.errors).toEqual([]);
  });

  test("leaves out the errors when the user turns them off", () => {
    expect("errors" in bugReportContext(MAC, "en", null)).toBe(false);
  });

  test("refuses a description too short once cleaned", () => {
    expect(() =>
      buildBugReport(
        ID,
        { description: "\u0000\u0001  short  \r\n", contactOk: false },
        bugReportContext(MAC, "en", null),
      ),
    ).toThrow();
  });

  test("names the app language ko or en", () => {
    expect(bugReportLocale("ko")).toBe("ko");
    expect(bugReportLocale("ko-KR")).toBe("ko");
    expect(bugReportLocale("en")).toBe("en");
    expect(bugReportLocale("fr")).toBe("en");
  });
});

describe("the OS a bug report names", () => {
  test.each([
    ["darwin", "26.1", "macOS-26.1"],
    ["win32", "10.0.26100", "Windows-10.0.26100"],
    ["linux", "6.8.0", "Linux-6.8.0"],
    ["freebsd", "14.1", "freebsd-14.1"],
    ["toString", "1.0", "toString-1.0"],
  ])("%s %s is sent as %s", (platform, version, sent) => {
    expect(bugReportOsVersion(platform, version)).toBe(sent);
  });

  test("spaces become dashes and the value fits the pattern", () => {
    const sent = bugReportOsVersion("linux", "6.8.0 generic");
    expect(sent).toBe("Linux-6.8.0-generic");
    expect(BUG_REPORT_OS_VERSION_PATTERN.test(sent)).toBe(true);
  });
});

describe("a recent error's code and message", () => {
  test("a code is built from parts, in lower case, within the pattern", () => {
    expect(bugReportErrorCode("writeFile", "PERMISSION_DENIED")).toBe(
      "write_file:permission_denied",
    );
    expect(bugReportErrorCode("renderer", "TypeError")).toBe("renderer:type_error");
    expect(bugReportErrorCode("page_gone", "crashed")).toBe("page_gone:crashed");
    expect(bugReportErrorCode("ssh.connect-failed")).toBe("ssh.connect-failed");
    expect(bugReportErrorCode("a b/c", "")).toBe("a_b_c");
    expect(bugReportErrorCode("", "  ")).toBeUndefined();
    const long = bugReportErrorCode("x".repeat(30), "y".repeat(30)) ?? "";
    expect(long.length).toBeLessThanOrEqual(40);
    expect(BUG_REPORT_ERROR_CODE_PATTERN.test(long)).toBe(true);
  });

  test("a message comes redacted from an Error, never from a SyntaxError", () => {
    expect(errorMessageOf(new Error("open '/Users/kim/a.md' failed"))).toBe("open '<path>' failed");
    expect(errorMessageOf(new SyntaxError('"note text" is not valid JSON'))).toBeUndefined();
    expect(errorMessageOf("not an error")).toBeUndefined();
    expect(errorMessageOf(new Error(""))).toBeUndefined();
    expect(errorNameOf(new TypeError("x"))).toBe("TypeError");
    expect(errorNameOf(null)).toBe("error");
  });

  test("the context redacts each message again and fits the server's limit", () => {
    const errors = Array.from({ length: 20 }, (_, n) => ({
      ago: n,
      area: "app" as const,
      code: `e${n}`,
      message: `${"가".repeat(280)} /Users/kim/x${n}.ts`,
    }));
    const context = bugReportContext(MAC, "en", errors);
    expect(bugReportBytes(context)).toBeLessThanOrEqual(MAX_BUG_REPORT_CONTEXT_BYTES);
    expect(context.errors?.[0]?.message).toBe(`${"가".repeat(280)} <path>`);
    expect(JSON.stringify(context)).not.toContain("/Users/kim");
    expect(BugReportContextSchema.safeParse(context).success).toBe(true);
  });

  test("a renderer's report is checked before it is recorded", () => {
    expect(
      ReportedErrorSchema.safeParse({ area: "agent", code: "claude:auth", status: 401 }).success,
    ).toBe(true);
    for (const bad of [
      { area: "terminal", code: "x" },
      { area: "app", code: "Bad Code" },
      { area: "app", code: "x", status: 99 },
      { area: "app", code: "x", message: "m".repeat(2001) },
    ]) {
      expect(ReportedErrorSchema.safeParse(bad).success).toBe(false);
    }
  });
});
