import { describe, expect, test } from "bun:test";
import {
  BugReportSchema,
  MAX_BUG_REPORT_DESCRIPTION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "../../../../packages/remote-protocol/src";
import {
  bugReportContext,
  bugReportFits,
  bugReportLength,
  bugReportLocale,
  buildBugReport,
  cleanBugReportDescription,
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
