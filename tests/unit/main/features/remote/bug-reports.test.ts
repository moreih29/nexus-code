import { describe, expect, test } from "bun:test";
import {
  BugReportSchema,
  bugReportBytes,
  MAX_BUG_REPORT_CONTEXT_BYTES,
  MAX_BUG_REPORT_ERROR_AGE,
} from "../../../../../packages/remote-protocol/src";
import { RemoteAccount, type SavedAccount } from "../../../../../src/main/features/remote/account";
import { BugReports } from "../../../../../src/main/features/remote/bug-reports";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import { RecentErrors } from "../../../../../src/main/infra/recent-errors";
import type { BugReportDraft } from "../../../../../src/shared/remote/bug-report";

const SERVER = "http://localhost:8787";
const PROXY = "https://proxy.example";
const saved: SavedAccount = {
  server: SERVER,
  token: "mock-token",
  user: { id: "u1", email: "someone@example.com", name: "Someone" },
  device: { id: "d1", name: "Test Mac", platform: "darwin" },
};
const FACTS = { appVersion: "1.4.0", osVersion: "25.1.0", arch: "arm64" };
const DRAFT: BugReportDraft = {
  description: "The terminal froze\r\nafter I pasted text.\u0000",
  contactOk: false,
  includeErrors: true,
  locale: "en",
};

type Answer = Response | Error;

function setUp(answers: Answer[], options: { proxy?: string } = {}) {
  const sent: { url: URL; auth?: string; body: unknown }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url,
      auth: headers.authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers.shift() ?? Response.json({ id: "r1", status: "open" }, { status: 201 });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  let now = 1_000_000;
  const errors = new RecentErrors(() => now);
  const account = new RemoteAccount({
    server: SERVER,
    ...(options.proxy ? { proxy: options.proxy } : {}),
    store: keptInMemory<SavedAccount>(saved),
    openExternal: async () => {},
    fetch: fetchFn,
    now: () => 0,
    recordError: errors.record,
  });
  let ids = 0;
  const reports = new BugReports({
    account,
    errors,
    facts: () => FACTS,
    newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    now: () => now,
  });
  return {
    account,
    reports,
    errors,
    sent,
    advance(ms: number) {
      now += ms;
    },
    preview(draft: BugReportDraft = DRAFT): BugReportDraft {
      return {
        ...draft,
        shown: { at: now, errors: reports.context(draft.locale, true).errors ?? [] },
      };
    },
  };
}

const refusal = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers });

describe("sending a bug report", () => {
  test("posts a body the schema takes to /bug-reports?v=1, signed in", async () => {
    const { account, reports, errors, sent, advance, preview } = setUp([]);
    await account.restore();
    errors.record("relay", "socket-closed");
    advance(42_000);
    expect(await reports.send(preview())).toEqual({ status: "sent", id: "r1" });
    const [request] = sent;
    expect(request?.url.pathname).toBe("/bug-reports");
    expect(request?.url.search).toBe("?v=1");
    expect(request?.auth).toBe("Bearer mock-token");
    const body = BugReportSchema.parse(request?.body);
    expect(body.description).toBe("The terminal froze\nafter I pasted text.");
    expect(body.context.errors).toEqual([{ ago: 42, area: "relay", code: "socket-closed" }]);
    expect(body.context.device).toEqual({ kind: "desktop", arch: "arm64" });
  });

  test("leaves the errors out when the user turns them off", async () => {
    const { account, reports, errors, sent, preview } = setUp([]);
    await account.restore();
    errors.record("api", "offline");
    await reports.send({ ...DRAFT, includeErrors: false });
    await reports.send({ ...preview(), includeErrors: false, description: "Another long text" });
    expect(BugReportSchema.parse(sent[0]?.body).context.errors).toBeUndefined();
    expect(BugReportSchema.parse(sent[1]?.body).context.errors).toBeUndefined();
  });

  test("sends the errors the preview showed, aged to now, and none that came after", async () => {
    const { account, reports, errors, sent, advance, preview } = setUp([]);
    await account.restore();
    errors.record("api", "offline", undefined, "the NexusCode server did not answer");
    advance(10_000);
    const shown = preview();
    advance(5_000);
    errors.record("files", "read_file:not_found", undefined, "report-2026.docx was not found");
    advance(5_000);
    await reports.send(shown);
    expect(BugReportSchema.parse(sent[0]?.body).context.errors).toEqual([
      { ago: 20, area: "api", code: "offline", message: "the NexusCode server did not answer" },
    ]);
    expect(JSON.stringify(sent[0]?.body)).not.toContain("report-2026");
  });

  test("drops a shown error that grew past 30 days, and sends none when nothing was shown", async () => {
    const { account, reports, sent, advance } = setUp([]);
    await account.restore();
    advance(10_000);
    await reports.send({
      ...DRAFT,
      shown: {
        at: 1_000_000,
        errors: [
          { ago: MAX_BUG_REPORT_ERROR_AGE - 5, area: "api", code: "old" },
          { ago: 3, area: "api", code: "new" },
        ],
      },
    });
    await reports.send({ ...DRAFT, description: "Another long text" });
    expect(BugReportSchema.parse(sent[0]?.body).context.errors).toEqual([
      { ago: 13, area: "api", code: "new" },
    ]);
    expect(BugReportSchema.parse(sent[1]?.body).context.errors).toEqual([]);
  });

  test("sends each error's message redacted, with how often it came", async () => {
    const { account, reports, errors, sent, preview } = setUp([]);
    await account.restore();
    const message =
      "EACCES: permission denied, open '/Users/kim/notes/plan.md' for kim@example.com";
    errors.record("files", "write_file:permission_denied", undefined, message);
    errors.record("files", "write_file:permission_denied", undefined, message);
    await reports.send(preview());
    const body = BugReportSchema.parse(sent[0]?.body);
    expect(body.context.errors).toEqual([
      {
        ago: 0,
        area: "files",
        code: "write_file:permission_denied",
        message: "EACCES: permission denied, open '<path>' for <email>",
        count: 2,
      },
    ]);
    expect(JSON.stringify(sent[0]?.body)).not.toContain("kim");
  });

  test("turned off, sends no message either", async () => {
    const { account, reports, errors, sent } = setUp([]);
    await account.restore();
    errors.record("app", "uncaught:type_error", undefined, "Cannot read properties of undefined");
    await reports.send({ ...DRAFT, includeErrors: false });
    expect(JSON.stringify(sent[0]?.body)).not.toContain("Cannot read");
    expect(reports.context("en", false).errors).toBeUndefined();
  });

  test("fits the context the server takes, keeping the newest messages", async () => {
    const { account, reports, errors, sent, advance, preview } = setUp([]);
    await account.restore();
    for (let n = 0; n < 20; n++) {
      errors.record("app", `e${n}`, undefined, `${"가".repeat(290)} ${n}`);
      advance(1000);
    }
    await reports.send(preview());
    const body = BugReportSchema.parse(sent[0]?.body);
    expect(bugReportBytes(body.context)).toBeLessThanOrEqual(MAX_BUG_REPORT_CONTEXT_BYTES);
    expect(body.context.errors).toHaveLength(20);
    expect(body.context.errors?.[0]).toMatchObject({
      code: "e19",
      message: `${"가".repeat(290)} 19`,
    });
    expect(body.context.errors?.at(-1)?.message).toBeUndefined();
    expect(reports.context("en", true)).toEqual(body.context);
  });

  test("sends the same id again after a failure, and a new one after it went", async () => {
    const { account, reports, sent } = setUp([
      refusal(500, "server_error"),
      new TypeError("fetch failed"),
      Response.json({ id: "r1", status: "open" }, { status: 200 }),
    ]);
    await account.restore();
    expect(await reports.send(DRAFT)).toMatchObject({ status: "failed", failure: "failed" });
    expect(await reports.send(DRAFT)).toMatchObject({ status: "failed", failure: "offline" });
    expect(await reports.send(DRAFT)).toEqual({ status: "sent", id: "r1" });
    await reports.send(DRAFT);
    const ids = sent.map((request) => (request.body as { id: string }).id);
    expect(ids).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  test("a changed report after a failure is a new one", async () => {
    const { account, reports, sent } = setUp([refusal(500, "server_error")]);
    await account.restore();
    await reports.send(DRAFT);
    await reports.send({ ...DRAFT, description: `${DRAFT.description} Again.` });
    const ids = sent.map((request) => (request.body as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  test.each([
    [
      "429 with Retry-After",
      refusal(429, "rate_limited", { "Retry-After": "120" }),
      { failure: "rate-limited", retryAfter: 120 },
    ],
    ["429 without Retry-After", refusal(429, "rate_limited"), { failure: "rate-limited" }],
    ["401", refusal(401, "unauthorized"), { failure: "signed-out" }],
    ["403 not_invited", refusal(403, "not_invited"), { failure: "not-allowed" }],
    ["403 other", refusal(403, "forbidden"), { failure: "not-allowed" }],
    ["413", refusal(413, "too_big"), { failure: "too-big" }],
    ["404", new Response("Not Found", { status: 404 }), { failure: "unsupported" }],
    ["400 unsupported_version", refusal(400, "unsupported_version"), { failure: "unsupported" }],
    ["400 bad_request", refusal(400, "bad_request"), { failure: "failed" }],
    ["500", refusal(500, "server_error"), { failure: "failed" }],
    ["a network failure", new TypeError("fetch failed"), { failure: "offline" }],
    [
      "a timeout",
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      { failure: "offline" },
    ],
    ["an answer it can't read", Response.json({ nope: true }), { failure: "failed" }],
  ] as const)("maps %s", async (_name, answer, failure) => {
    const { account, reports } = setUp([answer]);
    await account.restore();
    expect(await reports.send(DRAFT)).toEqual({ status: "failed", ...failure });
  });

  test("a 401 or 403 not_invited signs the computer out", async () => {
    for (const answer of [refusal(401, "unauthorized"), refusal(403, "not_invited")]) {
      const { account, reports } = setUp([answer]);
      await account.restore();
      await reports.send(DRAFT);
      expect(account.state().status).toBe("signed-out");
    }
  });

  test("signed out, nothing goes to the server", async () => {
    const { reports, sent } = setUp([]);
    expect(await reports.send(DRAFT)).toEqual({ status: "failed", failure: "signed-out" });
    expect(sent).toEqual([]);
  });

  test("takes the proxy's fallback route as other account requests do", async () => {
    const { account, reports, sent } = setUp([new TypeError("fetch failed")], { proxy: PROXY });
    await account.restore();
    expect(await reports.send(DRAFT)).toEqual({ status: "sent", id: "r1" });
    expect(sent.map((request) => request.url.origin)).toEqual([PROXY, SERVER]);
  });
});

describe("errors the account records", () => {
  test.each([
    [
      "an HTTP refusal",
      refusal(500, "server_error"),
      { code: "http_500", status: 500, message: "GET /devices: 500 server_error" },
    ],
    [
      "a 401",
      refusal(401, "unauthorized"),
      { code: "http_401", status: 401, message: "signed out of NexusCode" },
    ],
    [
      "a 403 not_invited",
      refusal(403, "not_invited"),
      { code: "http_403", status: 403, message: "signed out of NexusCode" },
    ],
    [
      "a network failure",
      new TypeError("fetch failed"),
      { code: "offline", message: "the NexusCode server did not answer: fetch failed" },
    ],
    [
      "a timeout",
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      { code: "timeout", message: "the NexusCode server did not answer: timed out" },
    ],
  ] as const)("records %s as area api", async (_name, answer, recorded) => {
    const { account, errors } = setUp([answer]);
    await account.restore();
    await account.devices().catch(() => {});
    expect(errors.list()).toEqual([{ ago: 0, area: "api", ...recorded }]);
  });

  test("records a phone push that failed as area push", async () => {
    const { account, errors } = setUp([refusal(503, "unavailable")]);
    await account.restore();
    const body = { id: "a".repeat(22), kind: "request", ttl: 600, to: ["phone"] } as const;
    await account
      .sendPush({ ...body, to: [...body.to] }, new AbortController().signal, 1000)
      .catch(() => {});
    expect(errors.list()).toEqual([
      {
        ago: 0,
        area: "push",
        code: "http_503",
        status: 503,
        message: "POST <path> 503 unavailable",
      },
    ]);
  });

  test("records nothing when it went, when it was called off, or when not signed in", async () => {
    const { account, errors } = setUp([Response.json({ devices: [] })]);
    await account.devices().catch(() => {});
    await account.restore();
    await account.devices();
    const stop = new AbortController();
    stop.abort();
    await account.request("GET", "/devices", undefined, undefined, stop.signal).catch(() => {});
    expect(errors.list()).toEqual([]);
  });

  test("records a failure reached through the fallback only once", async () => {
    const { account, errors } = setUp(
      [new TypeError("fetch failed"), new TypeError("fetch failed")],
      { proxy: PROXY },
    );
    await account.restore();
    await account.devices().catch(() => {});
    expect(errors.list()).toEqual([
      {
        ago: 0,
        area: "api",
        code: "offline",
        message: "the NexusCode server did not answer: fetch failed",
      },
    ]);
  });
});
