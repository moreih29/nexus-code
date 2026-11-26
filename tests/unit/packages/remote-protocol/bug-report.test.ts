import { describe, expect, test } from "bun:test";
import {
  BUG_REPORT_ERROR_AREAS,
  BUG_REPORT_ERRORS,
  BUG_REPORT_STATUSES,
  BUG_REPORT_VERSION,
  type BugReport,
  BugReportContextSchema,
  BugReportCreatedSchema,
  BugReportErrorSchema,
  BugReportRecentErrorSchema,
  BugReportSchema,
  bugReportBytes,
  cleanBugReportErrorMessage,
  fitBugReportContext,
  MAX_BUG_REPORT_BODY_BYTES,
  MAX_BUG_REPORT_CONTEXT_BYTES,
  MAX_BUG_REPORT_DESCRIPTION,
  MAX_BUG_REPORT_ERROR_AGE,
  MAX_BUG_REPORT_ERROR_COUNT,
  MAX_BUG_REPORT_ERROR_MESSAGE,
  MAX_BUG_REPORT_ERRORS,
  MAX_FRAME_BYTES,
  MIN_BUG_REPORT_DESCRIPTION,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  redactBugReportText,
  SCHEMA_VERSION,
} from "../../../../packages/remote-protocol/src";

const mobile: BugReport = {
  id: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  description: "보내기 버튼을 눌렀는데\n아무 일도 일어나지 않았습니다.",
  contactOk: true,
  context: {
    app: { version: "1.0.0", build: "20261124.3" },
    os: { version: "26.1" },
    device: { kind: "phone", model: "iPhone16,2" },
    protocol: { version: PROTOCOL_VERSION, package: "0.35.0" },
    locale: "ko",
    errors: [
      { ago: 42, area: "api", code: "http_500", status: 500 },
      { ago: 0, area: "relay", code: "offline" },
      {
        ago: 3,
        area: "files",
        code: "write_file:fs-error",
        message: "EACCES: permission denied, open '<path>'",
        count: 2,
      },
    ],
  },
};

const desktop: BugReport = {
  id: "0b9a8c7d-6e5f-7a4b-9c3d-2e1f0a9b8c7d",
  description: "The terminal froze after the workspace switched.",
  contactOk: false,
  context: {
    app: { version: "0.37.2" },
    os: { version: "5.15.153.1-microsoft-standard-WSL2" },
    device: { kind: "desktop", arch: "x64" },
    protocol: { version: PROTOCOL_VERSION, package: "0.35.0" },
    locale: "en",
  },
};

type Context = BugReport["context"];

const withContext = (change: (context: Context) => unknown) =>
  ({ ...mobile, context: change(structuredClone(mobile.context)) }) as unknown;

const accepts = (value: unknown) => BugReportSchema.safeParse(value).success;

describe("a bug report", () => {
  test("version 1 leaves the relay protocol as it was", () => {
    expect(BUG_REPORT_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe("0.40.0");
    expect(PROTOCOL_VERSION).toBe(2);
    expect(RELAY_VERSION).toBe(2);
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  test("a phone's report and a computer's are taken as sent", () => {
    expect(BugReportSchema.parse(mobile)).toEqual(mobile);
    expect(BugReportSchema.parse(desktop)).toEqual(desktop);
    const tablet = withContext((context) => ({
      ...context,
      device: { kind: "tablet", model: "iPad14,3" },
      errors: [],
    }));
    expect(accepts(tablet)).toBe(true);
  });

  test("the id is a UUID", () => {
    for (const id of ["", "report-1", "6f1c2d3e4b5a4c6d8e7f0a1b2c3d4e5f", `${mobile.id}0`]) {
      expect(accepts({ ...mobile, id })).toBe(false);
    }
    expect(accepts({ ...mobile, id: mobile.id.toUpperCase() })).toBe(true);
  });

  test("the description has 10 to 3000 code points", () => {
    expect(MIN_BUG_REPORT_DESCRIPTION).toBe(10);
    expect(MAX_BUG_REPORT_DESCRIPTION).toBe(3000);
    expect(accepts({ ...mobile, description: "a".repeat(9) })).toBe(false);
    expect(accepts({ ...mobile, description: "a".repeat(10) })).toBe(true);
    expect(accepts({ ...mobile, description: "가".repeat(3000) })).toBe(true);
    expect(accepts({ ...mobile, description: "a".repeat(3001) })).toBe(false);
    expect(accepts({ ...mobile, description: "😀".repeat(9) })).toBe(false);
    expect(accepts({ ...mobile, description: "😀".repeat(10) })).toBe(true);
    expect(accepts({ ...mobile, description: "😀".repeat(3000) })).toBe(true);
    expect(accepts({ ...mobile, description: "😀".repeat(3001) })).toBe(false);
  });

  test("the description keeps new lines and tabs", () => {
    const text = "line one\nline two\n\tindented";
    expect(BugReportSchema.parse({ ...mobile, description: text }).description).toBe(text);
  });

  test("the description refuses every other control character", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, code) => code).filter(
        (code) => code !== 9 && code !== 10,
      ),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    expect(controls).toContain(13);
    expect(controls).toContain(0x9f);
    for (const code of controls) {
      const description = `ten chars ${String.fromCharCode(code)} here`;
      expect(accepts({ ...mobile, description })).toBe(false);
    }
    expect(accepts({ ...mobile, description: "line one\r\nline two" })).toBe(false);
    expect(accepts({ ...mobile, description: "ten chars    here" })).toBe(true);
  });

  test("the description refuses a lone surrogate", () => {
    expect(accepts({ ...mobile, description: "ten chars \ud83d here" })).toBe(false);
    expect(accepts({ ...mobile, description: "ten chars \ude00 here" })).toBe(false);
    expect(accepts({ ...mobile, description: "ten chars \ude00\ud83d here" })).toBe(false);
    expect(accepts({ ...mobile, description: "ten chars 😀 here" })).toBe(true);
  });

  test("contactOk is a boolean", () => {
    expect(accepts({ ...mobile, contactOk: "true" })).toBe(false);
    const { contactOk: _, ...missing } = mobile;
    expect(accepts(missing)).toBe(false);
  });

  test("every field but build, model, arch, errors and status is required", () => {
    const required: Array<(context: Context) => unknown> = [
      ({ app: _, ...rest }) => rest,
      ({ os: _, ...rest }) => rest,
      ({ device: _, ...rest }) => rest,
      ({ protocol: _, ...rest }) => rest,
      ({ locale: _, ...rest }) => rest,
      (context) => ({ ...context, app: { build: "1" } }),
      (context) => ({ ...context, os: {} }),
      (context) => ({ ...context, device: { model: "iPhone16,2" } }),
      (context) => ({ ...context, protocol: { version: 2 } }),
      (context) => ({ ...context, protocol: { package: "0.35.0" } }),
      (context) => ({ ...context, errors: [{ area: "api", code: "x" }] }),
      (context) => ({ ...context, errors: [{ ago: 1, code: "x" }] }),
      (context) => ({ ...context, errors: [{ ago: 1, area: "api" }] }),
    ];
    for (const change of required) expect(accepts(withContext(change))).toBe(false);
    for (const key of ["id", "description", "context"] as const) {
      const { [key]: _, ...rest } = mobile;
      expect(accepts(rest)).toBe(false);
    }
  });
});

describe("a bug report refuses unknown keys", () => {
  const extra = { note: "free text" };

  test("at the top", () => {
    expect(accepts({ ...mobile, ...extra })).toBe(false);
  });

  test("in the context and each of its objects", () => {
    const changes: Array<(context: Context) => unknown> = [
      (context) => ({ ...context, ...extra }),
      (context) => ({ ...context, app: { ...context.app, ...extra } }),
      (context) => ({ ...context, os: { ...context.os, ...extra } }),
      (context) => ({ ...context, device: { ...context.device, ...extra } }),
      (context) => ({ ...context, protocol: { ...context.protocol, ...extra } }),
      (context) => ({ ...context, errors: [{ ago: 1, area: "api", code: "x", ...extra }] }),
    ];
    for (const change of changes) expect(accepts(withContext(change))).toBe(false);
    expect(BugReportContextSchema.safeParse({ ...mobile.context, ...extra }).success).toBe(false);
    expect(
      BugReportRecentErrorSchema.safeParse({ ago: 1, area: "api", code: "x", stack: "at a" })
        .success,
    ).toBe(false);
  });
});

describe("a bug report's context bounds", () => {
  const app = (value: Partial<Context["app"]>) =>
    withContext((context) => ({ ...context, app: { ...context.app, ...value } }));
  const os = (version: string) => withContext((context) => ({ ...context, os: { version } }));
  const device = (value: Partial<Context["device"]>) =>
    withContext((context) => ({ ...context, device: { ...context.device, ...value } }));
  const protocol = (value: Partial<Context["protocol"]>) =>
    withContext((context) => ({ ...context, protocol: { ...context.protocol, ...value } }));

  test("app version and build: 1 to 32 of letters, digits and . _ + -", () => {
    for (const key of ["version", "build"] as const) {
      expect(accepts(app({ [key]: "1.0.0-beta.1+exp_2" }))).toBe(true);
      expect(accepts(app({ [key]: "9".repeat(32) }))).toBe(true);
      expect(accepts(app({ [key]: "9".repeat(33) }))).toBe(false);
      expect(accepts(app({ [key]: "" }))).toBe(false);
      for (const bad of ["1.0 beta", "1.0/2", "1.0\n", "１.0"]) {
        expect(accepts(app({ [key]: bad }))).toBe(false);
      }
    }
  });

  test("os version: 1 to 64 of letters, digits and . _ + -", () => {
    for (const ok of ["26.1", "15", "10.0.26100", "6.8.0-45-generic", "9".repeat(64)]) {
      expect(accepts(os(ok))).toBe(true);
    }
    for (const bad of ["", "9".repeat(65), "Darwin 25.1.0", "6.8#1"]) {
      expect(accepts(os(bad))).toBe(false);
    }
  });

  test("device kind is phone, tablet or desktop", () => {
    for (const kind of ["phone", "tablet", "desktop"] as const) {
      expect(accepts(device({ kind }))).toBe(true);
    }
    for (const kind of ["watch", "Phone", ""]) {
      expect(accepts(device({ kind } as never))).toBe(false);
    }
  });

  test("device model: 1 to 40 of letters, digits, space and , . _ -", () => {
    for (const ok of ["iPhone16,2", "SM-S928N", "Pixel 9 Pro", "a".repeat(40)]) {
      expect(accepts(device({ model: ok }))).toBe(true);
    }
    for (const bad of ["", "a".repeat(41), "Kim's iPhone", "iPhone/16", "아이폰"]) {
      expect(accepts(device({ model: bad }))).toBe(false);
    }
  });

  test("device arch: 1 to 16 of lower-case letters, digits and _", () => {
    for (const ok of ["arm64", "x64", "x86_64", "riscv64", "a".repeat(16)]) {
      expect(accepts(device({ arch: ok }))).toBe(true);
    }
    for (const bad of ["", "a".repeat(17), "ARM64", "arm-64", "x86 64"]) {
      expect(accepts(device({ arch: bad }))).toBe(false);
    }
  });

  test("protocol version: an integer from 1 to 1000", () => {
    for (const ok of [1, 2, 1000]) expect(accepts(protocol({ version: ok }))).toBe(true);
    for (const bad of [0, -1, 1001, 2.5, Number.POSITIVE_INFINITY, Number.NaN, "2"]) {
      expect(accepts(protocol({ version: bad as number }))).toBe(false);
    }
  });

  test("protocol package: a version up to 9999.9999.9999 with a short pre-release", () => {
    for (const ok of ["0.35.0", "1.0.0-rc.1", "9999.9999.9999", `1.2.3-${"a".repeat(20)}`]) {
      expect(accepts(protocol({ package: ok }))).toBe(true);
    }
    for (const bad of ["", "0.35", "v0.35.0", "10000.0.0", "1.2.3-", `1.2.3-${"a".repeat(21)}`]) {
      expect(accepts(protocol({ package: bad }))).toBe(false);
    }
    expect(accepts(protocol({ package: "1.2.3+build" }))).toBe(false);
  });

  test("locale is ko or en", () => {
    for (const locale of ["ko", "en"]) {
      expect(accepts(withContext((context) => ({ ...context, locale })))).toBe(true);
    }
    for (const locale of ["ja", "ko-KR", "EN", ""]) {
      expect(accepts(withContext((context) => ({ ...context, locale })))).toBe(false);
    }
  });
});

describe("a bug report's recent errors", () => {
  const entry = { ago: 1, area: "api", code: "http_500", status: 500 };
  const errors = (list: unknown[]) => withContext((context) => ({ ...context, errors: list }));
  const one = (value: Record<string, unknown>) => errors([{ ...entry, ...value }]);

  test("are absent, empty or up to 20", () => {
    expect(MAX_BUG_REPORT_ERRORS).toBe(20);
    expect(accepts(withContext(({ errors: _, ...rest }) => rest))).toBe(true);
    expect(accepts(errors([]))).toBe(true);
    expect(accepts(errors(Array.from({ length: 20 }, () => entry)))).toBe(true);
    expect(accepts(errors(Array.from({ length: 21 }, () => entry)))).toBe(false);
    expect(accepts(errors(null as never))).toBe(false);
  });

  test("ago is whole seconds from 0 to 30 days", () => {
    expect(MAX_BUG_REPORT_ERROR_AGE).toBe(2_592_000);
    for (const ago of [0, 1, 2_592_000]) expect(accepts(one({ ago }))).toBe(true);
    for (const ago of [-1, 2_592_001, 1.5, Number.POSITIVE_INFINITY, "1"]) {
      expect(accepts(one({ ago }))).toBe(false);
    }
  });

  test("area is one of the eleven", () => {
    expect(BUG_REPORT_ERROR_AREAS).toEqual([
      "api",
      "relay",
      "voice",
      "push",
      "rpc",
      "render",
      "app",
      "agent",
      "notes",
      "files",
      "git",
    ]);
    for (const area of BUG_REPORT_ERROR_AREAS) expect(accepts(one({ area }))).toBe(true);
    for (const area of ["network", "API", "terminal", ""]) {
      expect(accepts(one({ area }))).toBe(false);
    }
  });

  test("message is optional: one line of 1 to 300 code points", () => {
    expect(MAX_BUG_REPORT_ERROR_MESSAGE).toBe(300);
    expect(accepts(one({ message: "x" }))).toBe(true);
    expect(accepts(one({ message: "가".repeat(300) }))).toBe(true);
    expect(accepts(one({ message: "😀".repeat(300) }))).toBe(true);
    expect(accepts(one({ message: "a".repeat(301) }))).toBe(false);
    expect(accepts(one({ message: "" }))).toBe(false);
    expect(accepts(one({ message: 1 }))).toBe(false);
  });

  test("message refuses control, line and direction characters and lone surrogates", () => {
    for (const char of [
      "\n",
      "\t",
      "\r",
      "\u0000",
      "\u007f",
      "\u0085",
      "\u2028",
      "\u2029",
      "\u202e",
      "\u2066",
      "\ufeff",
      "\ud83d",
      "\ude00",
    ]) {
      expect(accepts(one({ message: `a${char}b` }))).toBe(false);
    }
    expect(accepts(one({ message: "a b 😀 \u200d 가" }))).toBe(true);
  });

  test("count is an optional integer from 1 to 9999", () => {
    expect(MAX_BUG_REPORT_ERROR_COUNT).toBe(9999);
    for (const count of [1, 2, 9999]) expect(accepts(one({ count }))).toBe(true);
    for (const count of [0, -1, 10_000, 1.5, "2", null]) {
      expect(accepts(one({ count }))).toBe(false);
    }
  });

  test("code: 1 to 40 of lower-case letters, digits and _ . : -", () => {
    for (const code of ["http_500", "timeout", "offline", "type_error:fetch", "a.b-c", "a"]) {
      expect(accepts(one({ code }))).toBe(true);
    }
    expect(accepts(one({ code: "a".repeat(40) }))).toBe(true);
    for (const code of ["", "a".repeat(41), "TypeError", "no such file", "/Users/kim/a.ts"]) {
      expect(accepts(one({ code }))).toBe(false);
    }
  });

  test("status is an optional HTTP status from 100 to 599", () => {
    const { status: _, ...without } = entry;
    expect(accepts(errors([without]))).toBe(true);
    for (const status of [100, 429, 599]) expect(accepts(one({ status }))).toBe(true);
    for (const status of [99, 600, 0, 500.5, "500", null]) {
      expect(accepts(one({ status }))).toBe(false);
    }
  });

  const largestFacts = {
    app: { version: "9".repeat(32), build: "9".repeat(32) },
    os: { version: "9".repeat(64) },
    device: { kind: "desktop", model: "a".repeat(40), arch: "a".repeat(16) },
    protocol: { version: 1000, package: `9999.9999.9999-${"a".repeat(20)}` },
    locale: "en",
  } satisfies Omit<Context, "errors">;
  const largestError = (message?: string) => ({
    ago: 2_592_000,
    area: "agent" as const,
    code: "a".repeat(40),
    status: 599,
    count: 9999,
    ...(message === undefined ? {} : { message }),
  });

  test("without messages, the largest context fits the 8 KB limit", () => {
    expect(MAX_BUG_REPORT_CONTEXT_BYTES).toBe(8192);
    const largest: Context = {
      ...largestFacts,
      errors: Array.from({ length: 20 }, () => largestError()),
    };
    expect(BugReportContextSchema.safeParse(largest).success).toBe(true);
    expect(bugReportBytes(largest)).toBeLessThanOrEqual(MAX_BUG_REPORT_CONTEXT_BYTES);
    expect(fitBugReportContext(largest)).toBe(largest);
  });

  test("fitting keeps a context that fits as it is", () => {
    expect(fitBugReportContext(mobile.context)).toBe(mobile.context);
    const empty = { ...mobile.context, errors: undefined };
    expect(fitBugReportContext(empty)).toBe(empty);
  });

  test("fitting drops the oldest errors' messages first, then the oldest errors", () => {
    const largest: Context = {
      ...largestFacts,
      errors: Array.from({ length: 20 }, (_, i) => ({
        ...largestError(`"${"😀".repeat(299)}`),
        code: `e${i}`,
      })),
    };
    expect(BugReportContextSchema.safeParse(largest).success).toBe(true);
    expect(bugReportBytes(largest)).toBeGreaterThan(MAX_BUG_REPORT_CONTEXT_BYTES);
    const fitted = fitBugReportContext(largest);
    expect(BugReportContextSchema.safeParse(fitted).success).toBe(true);
    expect(bugReportBytes(fitted)).toBeLessThanOrEqual(MAX_BUG_REPORT_CONTEXT_BYTES);
    const errors = fitted.errors ?? [];
    expect(errors.map(({ code }) => code)).toEqual(largest.errors?.map(({ code }) => code));
    const kept = errors.findIndex((error) => error.message === undefined);
    expect(kept).toBeGreaterThan(0);
    expect(errors.slice(0, kept).every((error) => error.message !== undefined)).toBe(true);
    expect(errors.slice(kept).every((error) => error.message === undefined)).toBe(true);
    expect(largest.errors?.[19].message).toBeDefined();
    const tight = fitBugReportContext(largest, 1024);
    expect(bugReportBytes(tight)).toBeLessThanOrEqual(1024);
    expect(tight.errors?.length).toBeLessThan(20);
    expect(tight.errors?.[0].code).toBe("e0");
  });

  test("a fitted body with the longest description stays under 24 KB", () => {
    expect(MAX_BUG_REPORT_BODY_BYTES).toBe(24 * 1024);
    const context = fitBugReportContext({
      ...largestFacts,
      errors: Array.from({ length: 20 }, () => largestError("😀".repeat(300))),
    });
    const body = { ...mobile, description: "😀".repeat(3000), context };
    expect(accepts(body)).toBe(true);
    expect(bugReportBytes(body)).toBeLessThanOrEqual(MAX_BUG_REPORT_BODY_BYTES);
  });
});

describe("redacting a bug report's text", () => {
  const redacts = (text: string, expected: string) =>
    expect(redactBugReportText(text)).toBe(expected);

  test("POSIX paths, whole, under any root", () => {
    for (const root of ["Users", "home", "tmp", "private", "var", "Volumes", "opt", "mnt"]) {
      redacts(`failed at /${root}/kim/project/a.ts now`, "failed at <path> now");
    }
    redacts("at run (/Users/kim/app/src/x.ts:10:5)", "at run (<path>)");
    redacts("in /home/kim/John Smith/Documents/a.ts here", "in <path> here");
    for (const path of ["~/notes/plan.md", "~kim/x", "./src/a.ts", "../b/c"]) {
      redacts(`read ${path}, then stopped`, "read <path> then stopped");
    }
    redacts("file=/Users/kim/a.txt", "file=<path>");
  });

  test("quoted paths with spaces and relative paths in system call errors", () => {
    redacts(
      "ENOENT: no such file or directory, open '/Users/kim/My Notes/a b.md'",
      "ENOENT: no such file or directory, open '<path>'",
    );
    redacts(
      "ENOENT: no such file or directory, open 'notes/plan.md'",
      "ENOENT: no such file or directory, open '<path>'",
    );
    redacts(
      "EXDEV: cross-device link not permitted, rename 'a/b' -> 'c/d'",
      "EXDEV: cross-device link not permitted, rename '<path>' -> '<path>'",
    );
    redacts('Cannot find module "/Users/kim/x.js"', 'Cannot find module "<path>"');
  });

  test("Windows paths: drive, long, UNC, slashes and JSON-escaped", () => {
    redacts("C:\\Users\\kim\\AppData\\x.txt not found", "<path> not found");
    redacts("c:/Users/kim/x.txt not found", "<path> not found");
    redacts("\\\\?\\C:\\Users\\kim\\x.txt", "<path>");
    redacts("\\\\.\\pipe\\nexus-kim", "<path>");
    redacts("open \\\\server\\share\\dir\\f.txt", "open <path>");
    redacts("open //server/share/dir/f.txt", "open <path>");
    redacts('{"path":"C:\\\\Users\\\\kim\\\\x.txt"}', '{"path":"<path>"}');
    redacts('{"path":"\\\\\\\\server\\\\share\\\\x"}', '{"path":"<path>"}');
    redacts("C:\\Program Files (x86)\\Kim Tools\\bar.exe crashed", "<path> crashed");
  });

  test("a home folder's name, spaces and all, up to a separator, a quote or a stop", () => {
    for (const prefix of [
      "C:\\Users\\",
      "c:\\users\\",
      "C:/Users/",
      "D:\\Users\\",
      "C:\\\\Users\\\\",
      "\\\\?\\C:\\Users\\",
      "\\\\\\\\?\\\\C:\\\\Users\\\\",
      "/Users/",
      "/home/",
    ]) {
      redacts(`cannot access ${prefix}John Smith`, "cannot access <path>");
      redacts(`cannot access ${prefix}John Smith\r\nnext`, "cannot access <path>\r\nnext");
      redacts(`cannot access ${prefix}John Smith: denied`, "cannot access <path>: denied");
      redacts(`cannot access ${prefix}John Smith, retry`, "cannot access <path>, retry");
      redacts(`(${prefix}John Smith)`, "(<path>)");
      redacts(`"${prefix}John Smith" denied`, '"<path>" denied');
    }
    redacts('{"m":"open C:\\\\Users\\\\John Smith"}', '{"m":"open <path>"}');
    redacts("cannot access C:\\Users\\O'Brien Smith", "cannot access <path>");
    redacts("C:\\Users\\John Smith\\x", "<path>");
    redacts("C:\\Users\\QAUser\\내 문서\\a b.txt", "<path>");
    redacts("cannot access C:\\Users\\John Smith because it is locked", "cannot access <path>");
    redacts("C:\\Users\\kim was not found", "<path>");
    redacts("C:\\Users\\kim\\x.txt was not found", "<path> was not found");
    redacts("copy C:\\Users\\A B to C:\\Users\\C D", "copy <path> <path>");
    redacts("C:\\Users\\A B see https://h.example.com/a", "<path> https://h.example.com/a");
    redacts("C:\\Users\\A B or /home/c d", "<path> <path>");
  });

  test("a file name's words after a space, when one of the next four ends in an extension", () => {
    redacts("C:\\Users\\QA\\My Documents\\final report.txt", "<path>");
    redacts("open D:\\tmp\\보고서 최종.docx failed", "open <path> failed");
    redacts("C:\\a\\final report v2 draft.txt not found", "<path> not found");
    redacts("in /Users/kim/My Notes/final report.md now", "in <path> now");
    redacts("open \\\\srv\\sh\\a b.txt", "open <path>");
    redacts("read ./a b.txt", "read <path>");
    redacts('{"p":"C:\\\\a\\\\final report.txt"}', '{"p":"<path>"}');
    redacts("(C:\\a\\final report.txt)", "(<path>)");
    redacts("C:\\a\\final report.txt.", "<path>.");
    redacts("C:\\a\\final report.txt: denied", "<path>: denied");
    redacts("C:\\a\\b v1.2a", "<path>");
    redacts("C:\\a\\x a b c d.txt", "<path>");
    redacts("C:\\a\\x a b c d e.txt", "<path> a b c d e.txt");
  });

  test("a file name's words stop where 0.36.2's home folder name stops, and at a sentence", () => {
    redacts("C:\\a\\b\nc.txt", "<path>\nc.txt");
    redacts("C:\\a\\b\r\nc.txt", "<path>\r\nc.txt");
    redacts("C:\\a\\b 'c.txt'", "<path> 'c.txt'");
    redacts('C:\\a\\b "c.txt"', '<path> "c.txt"');
    for (const stop of [":", ";", ",", "=", "+", "*", "?", "[", "]", "<", ">", "|"]) {
      redacts(`C:\\a\\b ${stop} c.txt`, `<path> ${stop} c.txt`);
    }
    redacts("C:\\a\\b.txt, and c.txt", "<path> and c.txt");
    redacts("C:\\a\\b: c.txt", "<path> c.txt");
    redacts("C:\\a\\b. c.txt", "<path> c.txt");
    redacts("(C:\\a\\b) and c.txt", "(<path>) and c.txt");
    redacts("C:\\a\\b not found. See docs.html", "<path> not found. See docs.html");
    redacts("C:\\a\\b failed on node 20.11.1", "<path> failed on node 20.11.1");
    redacts("C:\\a\\final report.abcdefghi", "<path> report.abcdefghi");
    redacts("C:\\a\\b /Users/kim/x c.txt", "<path> <path>");
    redacts("copy C:\\a\\b c.txt to D:\\x y.txt", "copy <path> to <path>");
    redacts("C:\\a\\b.txt and c.txt", "<path>");
  });

  test("file URLs", () => {
    redacts("load file:///Users/kim/a.html failed", "load <path> failed");
    redacts("load file:/C:/Users/kim/a.html failed", "load <path> failed");
    redacts("load FILE://server/share/a.html", "load <path>");
  });

  test("emails", () => {
    redacts("signed in as kim.lee+test@example.com today", "signed in as <email> today");
    redacts("git@github.example.com: denied", "<email>: denied");
  });

  test("tokens and keys", () => {
    redacts("Authorization: Bearer abc123", "Authorization: <secret> <secret>");
    redacts("sent bearer abcdefghijklmnopq", "sent bearer <secret>");
    redacts("Basic dXNlcjpwYXNz failed", "Basic <secret> failed");
    redacts("key sk-ant-api03-AbCdEf1234567890xyz leaked", "key <secret> leaked");
    redacts("key sk-proj-abcdefghijklmnop1234 leaked", "key <secret> leaked");
    redacts(`pat ghp_${"a1".repeat(18)} here`, "pat <secret> here");
    redacts(`aws AKIA${"A1B2C3D4E5F6G7H8"} here`, "aws <secret> here");
    redacts(
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "jwt <secret>",
    );
    redacts("id 3f786850e387550fdab836ed7e6dc881de23001b done", "id <secret> done");
    redacts("id 0x3f786850e387550fdab836ed7e6dc881de23001b done", "id <secret> done");
    redacts("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ12345abcdeXYZ== done", "blob <secret> done");
    redacts(
      'password=hunter2 api_key: "xyz" refresh_token=abc',
      "password=<secret> api_key: <secret> refresh_token=<secret>",
    );
    redacts("x-account-auth: abc.def", "x-account-auth: <secret>");
    redacts(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- done",
      "<secret> done",
    );
  });

  test("URLs keep their scheme, host and path, not their user, query or fragment", () => {
    redacts(
      "GET https://kim:pw@api.example.com/v1/items?token=abc&x=1#top failed",
      "GET https://api.example.com/v1/items failed",
    );
    redacts("wss://relay.example.com/relay?v=2&ticket=t1", "wss://relay.example.com/relay");
  });

  test("IP addresses, but not loopback", () => {
    redacts("connect ECONNREFUSED 10.0.0.12:22", "connect ECONNREFUSED <ip>:22");
    redacts("connect ECONNREFUSED 127.0.0.1:3000", "connect ECONNREFUSED 127.0.0.1:3000");
    redacts("listen 0.0.0.0", "listen 0.0.0.0");
    redacts("via fe80::1c2b:3d4e:5f60:7a8b now", "via <ip> now");
    redacts("via 2001:db8:0:0:0:0:2:1 now", "via <ip> now");
    redacts("via ::1 at 12:30:45", "via ::1 at 12:30:45");
  });

  test("keeps what carries no person", () => {
    for (const text of [
      "spawn claude ENOENT",
      "Cannot read properties of undefined (reading 'text')",
      "POST /bug-reports?v=1 failed with 500",
      "max_tokens: 4096",
      "basic authentication failed",
      'Bearer realm="api"',
      "src/renderer/components/settings/panels",
      "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
      "http_500 timeout",
    ]) {
      expect(redactBugReportText(text)).toBe(text);
    }
  });
});

describe("cleaning an error message", () => {
  test("redacts, keeps one line and fits the schema", () => {
    expect(cleanBugReportErrorMessage("open '/Users/kim/a.md'\n  at x\tb\u202ec")).toBe(
      "open '<path>' at x b c",
    );
    expect(cleanBugReportErrorMessage("  \n\t ")).toBeUndefined();
    expect(cleanBugReportErrorMessage("")).toBeUndefined();
  });

  test("cuts a long message at a word to at most 300 code points, ending in an ellipsis", () => {
    const long = cleanBugReportErrorMessage("😀".repeat(400)) ?? "";
    expect(Array.from(long)).toHaveLength(300);
    expect(long.endsWith(" …")).toBe(true);
    const words = cleanBugReportErrorMessage("word ".repeat(100)) ?? "";
    expect(Array.from(words).length).toBeLessThanOrEqual(300);
    expect(words.endsWith(" word …")).toBe(true);
    expect(cleanBugReportErrorMessage("x".repeat(300))).toBe("x".repeat(300));
  });

  test("redacts before it cuts, so no secret is left half", () => {
    const text = `${"a ".repeat(140)}sk-ant-api03-${"x1".repeat(40)}`;
    const cleaned = cleanBugReportErrorMessage(text) ?? "";
    expect(cleaned).toContain("<secret>");
    expect(cleaned).not.toContain("x1x1");
  });

  test("what it gives is a valid message", () => {
    for (const text of [
      "a\u0000b\u0085c\u2028d",
      "😀".repeat(500),
      "\ud83d lone",
      "C:\\Users\\kim\\a.txt\r\nnext",
    ]) {
      const message = cleanBugReportErrorMessage(text);
      expect(
        BugReportRecentErrorSchema.safeParse({ ago: 0, area: "app", code: "x", message }).success,
      ).toBe(true);
    }
  });
});

const KNOWN_INPUTS = [
  "failed at /Users/kim/project/a.ts now",
  "failed at /Volumes/kim/project/a.ts now",
  "at run (/Users/kim/app/src/x.ts:10:5)",
  "in /home/kim/John Smith/Documents/a.ts here",
  "read ~/notes/plan.md, then stopped",
  "read ~kim/x, then stopped",
  "read ./src/a.ts, then stopped",
  "read ../b/c, then stopped",
  "file=/Users/kim/a.txt",
  "ENOENT: no such file or directory, open '/Users/kim/My Notes/a b.md'",
  "ENOENT: no such file or directory, open 'notes/plan.md'",
  "EXDEV: cross-device link not permitted, rename 'a/b' -> 'c/d'",
  'Cannot find module "/Users/kim/x.js"',
  "C:\\Users\\kim\\AppData\\x.txt not found",
  "c:/Users/kim/x.txt not found",
  "\\\\?\\C:\\Users\\kim\\x.txt",
  "\\\\.\\pipe\\nexus-kim",
  "open \\\\server\\share\\dir\\f.txt",
  "open //server/share/dir/f.txt",
  '{"path":"C:\\\\Users\\\\kim\\\\x.txt"}',
  '{"path":"\\\\\\\\server\\\\share\\\\x"}',
  "C:\\Program Files (x86)\\Kim Tools\\bar.exe crashed",
  "cannot access C:\\Users\\John Smith",
  "cannot access c:/users/John Smith: denied",
  "cannot access \\\\?\\C:\\Users\\John Smith, retry",
  "open C:\\\\Users\\\\John Smith",
  "stat /home/john smith\nnext",
  "cannot access C:\\Users\\O'Brien Smith",
  "C:\\Users\\QAUser\\내 문서\\a b.txt",
  "C:\\Users\\QA\\My Documents\\final report.txt",
  "open D:\\tmp\\보고서 최종.docx failed",
  "C:\\a\\final report v2 draft.txt not found",
  "in /Users/kim/My Notes/final report.md now",
  "(C:\\a\\final report.txt)",
  "C:\\a\\final report.txt.",
  "C:\\a\\x a b c d.txt",
  "C:\\a\\x a b c d e.txt",
  "C:\\a\\b.txt, and c.txt",
  "C:\\a\\b. c.txt",
  "C:\\a\\b not found. See docs.html",
  "C:\\a\\b failed on node 20.11.1",
  "C:\\a\\b.txt and c.txt",
  "copy C:\\Users\\A B to C:\\Users\\C D",
  "C:\\Users\\A B see https://h.example.com/a",
  "load file:///Users/kim/a.html failed",
  "load file:/C:/Users/kim/a.html failed",
  "load FILE://server/share/a.html",
  "signed in as kim.lee+test@example.com today",
  "git@github.example.com: denied",
  "Authorization: Bearer abc123",
  "sent bearer abcdefghijklmnopq",
  "Basic dXNlcjpwYXNz failed",
  "key sk-ant-api03-AbCdEf1234567890xyz leaked",
  "key sk-proj-abcdefghijklmnop1234 leaked",
  `pat ghp_${"a1".repeat(18)} here`,
  "aws AKIAA1B2C3D4E5F6G7H8 here",
  "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "id 3f786850e387550fdab836ed7e6dc881de23001b done",
  "id 0x3f786850e387550fdab836ed7e6dc881de23001b done",
  "blob QWxhZGRpbjpvcGVuIHNlc2FtZQ12345abcdeXYZ== done",
  'password=hunter2 api_key: "xyz" refresh_token=abc',
  "x-account-auth: abc.def",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- done",
  "GET https://kim:pw@api.example.com/v1/items?token=abc&x=1#top failed",
  "wss://relay.example.com/relay?v=2&ticket=t1",
  "connect ECONNREFUSED 10.0.0.12:22",
  "connect ECONNREFUSED 127.0.0.1:3000",
  "listen 0.0.0.0",
  "via fe80::1c2b:3d4e:5f60:7a8b now",
  "via 2001:db8:0:0:0:0:2:1 now",
  "via ::1 at 12:30:45",
  "spawn claude ENOENT",
  "Cannot read properties of undefined (reading 'text')",
  "POST /bug-reports?v=1 failed with 500",
  "max_tokens: 4096",
  "basic authentication failed",
  'Bearer realm="api"',
  "src/renderer/components/settings/panels",
  "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "http_500 timeout",
  "open '/Users/kim/a.md'\n  at x\tb\u202ec",
  "  \n\t ",
  "",
  "😀".repeat(400),
  "x".repeat(300),
  `${"a ".repeat(140)}sk-ant-api03-${"x1".repeat(40)}`,
  "a\u0000b\u0085c\u2028d",
  "😀".repeat(500),
  "\ud83d lone",
  "C:\\Users\\kim\\a.txt\r\nnext",
];

const EDGE_INPUTS = [
  "Bearer 10.0.0.",
  "Bearer 10.0.0.…",
  "<ip>Bearer 10.0.0.",
  "a@b.ccBearer 10.0.0.",
  "fe80::1~/n.md",
  "10.0.0.1~/n.md",
  "kim@example.com//srv/sh/x",
  "kim@example.com\\\\srv\\sh\\x",
  "kim@example.comC:\\Users\\kim\\a.txt",
  "a\u0000/Users/kim/x",
  "a\u202e~/n.md",
  "<path>~/n.md",
  "<email>//srv/sh/x",
  "token=…",
  "password: …",
  "Authorization: …",
  "…/Users/kim/a",
  "'…'",
  "<secret>",
  "<path> <secret> <email> <ip>",
];

const RANDOM_PARTS = [
  "/Users/kim/a.ts",
  "/tmp/x",
  "~/n.md",
  "./a/b",
  "C:\\Users\\kim\\a.txt",
  "C:\\Users\\John Smith",
  "c:/users/",
  "\\\\?\\C:\\Users\\",
  "/home/kim lee",
  "a b.txt",
  " final report.docx",
  "보고서 최종.hwp",
  "e.g.",
  "v1.2a",
  "20.11.1",
  "c.abcdefghi",
  "/Users/",
  "O'Brien",
  "\\\\srv\\sh\\x",
  "//srv/sh/x",
  "file:///a/b",
  "kim@example.com",
  "a@b.cc",
  "sk-ant-api03-AbCdEf1234567890xyz",
  `ghp_${"a1".repeat(12)}`,
  "AKIA",
  "0x",
  "Bearer",
  "Basic",
  "bearer",
  "Authorization:",
  "token=abc",
  "password:",
  "api_key",
  "10.0.0.",
  "10.0.0.1",
  "127.0.0.1",
  "fe80::1",
  "::1",
  "aa:bb:cc:dd:ee:ff",
  "https://u:p@h.example.com/a?b=1#c",
  "http://h/x",
  "3f786850e387550fdab836ed7e6dc881de23001b",
  "QWxhZGRpbjpvcGVuIHNlc2FtZQ12345abcdeXYZ==",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
  "dXNlcjpwYXNz",
  "open",
  "-> ",
  "'",
  '"',
  "`",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ";",
  ":",
  "=",
  ".",
  "-",
  "_",
  "/",
  "\\",
  "@",
  " ",
  " ",
  " ",
  "\t",
  "\n",
  "…",
  "<path>",
  "<secret>",
  "<email>",
  "<ip>",
  "x",
  "ab",
  "123",
  "\u0000",
  "\u202e",
  "가",
  "😀",
];

function randomInputs(count: number): string[] {
  let seed = 20261124;
  const next = (below: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % below;
  };
  return Array.from({ length: count }, (_, index) => {
    const parts = index % 10 === 0 ? 60 + next(200) : 1 + next(10);
    return Array.from({ length: parts }, () => RANDOM_PARTS[next(RANDOM_PARTS.length)]).join("");
  });
}

function unstable(text: string): string | undefined {
  const redacted = redactBugReportText(text);
  if (redactBugReportText(redacted) !== redacted) return `redact ${JSON.stringify(text)}`;
  const cleaned = cleanBugReportErrorMessage(text);
  if (cleaned === undefined) return undefined;
  if (cleanBugReportErrorMessage(cleaned) !== cleaned) return `clean ${JSON.stringify(text)}`;
  if (redactBugReportText(cleaned) !== cleaned) return `redact after clean ${JSON.stringify(text)}`;
  if (Array.from(cleaned).length > MAX_BUG_REPORT_ERROR_MESSAGE)
    return `long ${JSON.stringify(text)}`;
  return undefined;
}

const unstableOf = (texts: string[]) => texts.map(unstable).filter((found) => found !== undefined);

describe("redacting and cleaning twice gives what once gave", () => {
  test("for every input of the tests above and the edge cases", () => {
    expect(unstableOf([...KNOWN_INPUTS, ...EDGE_INPUTS])).toEqual([]);
  });

  test("the first pass already takes out what a second would", () => {
    expect(redactBugReportText("Bearer 10.0.0.")).toBe("Bearer <secret>");
    expect(redactBugReportText("fe80::1~/n.md")).toBe("<ip><path>");
    expect(redactBugReportText("kim@example.com//srv/sh/x")).toBe("<email><path>");
    expect(redactBugReportText("kim@example.com\\\\srv\\sh\\x")).toBe("<email><path>");
    expect(redactBugReportText("copy C:\\Users\\A B to C:\\Users\\C D")).toBe("copy <path> <path>");
    expect(redactBugReportText("\\\\?\\C:\\Users\\John Smith")).toBe("<path>");
    expect(cleanBugReportErrorMessage("a\u0000/Users/kim/x")).toBe("a <path>");
    expect(cleanBugReportErrorMessage("a\u202e~/n.md")).toBe("a <path>");
  });

  test("an ellipsis is never taken for a secret's value", () => {
    for (const text of ["password: …", "token=…", "Authorization: …"]) {
      expect(redactBugReportText(text)).toBe(text);
    }
  });

  test("what redacting falls back to when it does not settle is itself settled", () => {
    expect(redactBugReportText("<secret>")).toBe("<secret>");
    expect(cleanBugReportErrorMessage("<secret>")).toBe("<secret>");
  });

  test("for 5000 seeded random mixes of paths, keys, addresses and punctuation", () => {
    const inputs = randomInputs(5000);
    expect(unstableOf(inputs)).toEqual([]);
    for (const text of inputs) {
      const message = cleanBugReportErrorMessage(text);
      if (message === undefined) continue;
      expect(
        BugReportRecentErrorSchema.safeParse({ ago: 0, area: "app", code: "x", message }).success,
      ).toBe(true);
    }
  });

  test("at the 300 code point cut, whatever the cut lands in", () => {
    const tails = [
      "3f786850e387550fdab836ed7e6dc881de23001b",
      `${"0123456789abcdef".repeat(10)}z`,
      `password: ${"1".repeat(31)}`,
      `password: ${"1".repeat(120)}`,
      "Bearer 10.0.0.1",
      "kim@example.com",
      "/Users/kim/a b/c.ts",
      "10.0.0.12",
      "fe80::1c2b:3d4e:5f60:7a8b",
      `sk-ant-api03-${"x1".repeat(20)}`,
      "😀😀😀 가나다",
      "<secret> <ip>",
      "… …",
    ];
    const inputs: string[] = [];
    for (let pad = 240; pad <= 310; pad++) {
      for (const tail of tails) {
        inputs.push(`${"x".repeat(pad)} ${tail} end`);
        inputs.push(`${"ab ".repeat(Math.floor(pad / 3))}${tail} ${tail}`);
      }
    }
    expect(unstableOf(inputs)).toEqual([]);
    const hex = cleanBugReportErrorMessage(`${"x ".repeat(100)}${"0123456789abcdef".repeat(10)}z`);
    expect(hex?.endsWith("<secret> …")).toBe(true);
    const number = cleanBugReportErrorMessage(`${"x ".repeat(135)}password: ${"1".repeat(31)} end`);
    expect(number?.endsWith("password: …")).toBe(true);
  });

  test("an 8 KB hostile input takes tens of milliseconds at most", () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(8192 / unit.length)).slice(0, 8192);
    for (const unit of [
      "/",
      "/a ",
      "a b/",
      "\\",
      "\\\\a\\ ",
      "a@",
      "1.",
      ":",
      "a:",
      "'/",
      "password=",
      "Bearer ",
      "Ab1",
      "~/a b/c d\\e ",
      "C:\\a ",
      "C:\\Users\\a ",
      "/home/a b",
      "C:\\Users\\a'",
      "http://a@",
      "<ip>~/a",
      "a@b.cc/",
      "C:\\a b.c ",
      "/a/b c d e f.g ",
      "a b.txt ",
      "x.y.z ",
    ]) {
      const text = fill(unit);
      const started = performance.now();
      redactBugReportText(text);
      cleanBugReportErrorMessage(text);
      expect(performance.now() - started).toBeLessThan(80);
    }
  });
});

describe("the server's answer", () => {
  test("names the report and its status", () => {
    expect(BUG_REPORT_STATUSES).toEqual(["open", "reviewing", "closed"]);
    const created = { id: "br_8f3a2c", status: "open" };
    expect(BugReportCreatedSchema.parse(created)).toEqual(created);
    expect(BugReportCreatedSchema.parse({ id: mobile.id, status: "closed" }).status).toBe("closed");
    expect(BugReportCreatedSchema.parse({ ...created, later: 1 })).toEqual(created);
    for (const bad of [
      { ...created, status: "fixed" },
      { ...created, id: "" },
      { ...created, id: "a".repeat(65) },
      { status: "open" },
    ]) {
      expect(BugReportCreatedSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("lists its error codes", () => {
    expect(BUG_REPORT_ERRORS).toEqual([
      "bad_request",
      "unsupported_version",
      "unauthorized",
      "not_invited",
      "too_big",
      "rate_limited",
      "server_error",
    ]);
    for (const code of BUG_REPORT_ERRORS) expect(BugReportErrorSchema.parse(code)).toBe(code);
    expect(BugReportErrorSchema.safeParse("not_a_phone").success).toBe(false);
  });
});
