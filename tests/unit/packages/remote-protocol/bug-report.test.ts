import { describe, expect, test } from "bun:test";
import {
  BUG_REPORT_ERRORS,
  BUG_REPORT_STATUSES,
  BUG_REPORT_VERSION,
  type BugReport,
  BugReportContextSchema,
  BugReportCreatedSchema,
  BugReportErrorSchema,
  BugReportRecentErrorSchema,
  BugReportSchema,
  MAX_BUG_REPORT_CONTEXT_BYTES,
  MAX_BUG_REPORT_DESCRIPTION,
  MAX_BUG_REPORT_ERROR_AGE,
  MAX_BUG_REPORT_ERRORS,
  MAX_FRAME_BYTES,
  MIN_BUG_REPORT_DESCRIPTION,
  PROTOCOL_VERSION,
  RELAY_VERSION,
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

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("a bug report", () => {
  test("version 1 leaves the relay protocol as it was", () => {
    expect(BUG_REPORT_VERSION).toBe(1);
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
      BugReportRecentErrorSchema.safeParse({ ago: 1, area: "api", code: "x", message: "/Users/a" })
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

  test("area is one of the six", () => {
    for (const area of ["api", "relay", "voice", "push", "rpc", "render"]) {
      expect(accepts(one({ area }))).toBe(true);
    }
    for (const area of ["network", "API", ""]) expect(accepts(one({ area }))).toBe(false);
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

  test("the largest valid context stays under the server's 4 KB limit", () => {
    expect(MAX_BUG_REPORT_CONTEXT_BYTES).toBe(4096);
    const largest: Context = {
      app: { version: "9".repeat(32), build: "9".repeat(32) },
      os: { version: "9".repeat(64) },
      device: { kind: "desktop", model: "a".repeat(40), arch: "a".repeat(16) },
      protocol: { version: 1000, package: `9999.9999.9999-${"a".repeat(20)}` },
      locale: "en",
      errors: Array.from({ length: 20 }, () => ({
        ago: 2_592_000,
        area: "render" as const,
        code: "a".repeat(40),
        status: 599,
      })),
    };
    expect(BugReportContextSchema.safeParse(largest).success).toBe(true);
    expect(bytesOf(largest)).toBeLessThanOrEqual(MAX_BUG_REPORT_CONTEXT_BYTES);
    const body = { ...mobile, description: "😀".repeat(3000), context: largest };
    expect(accepts(body)).toBe(true);
    expect(bytesOf(body)).toBeLessThanOrEqual(16 * 1024);
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
