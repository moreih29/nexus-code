/**
 * The page the browser shows once it is back from the sign-in: the app's own
 * words for what the callback said, in the app's language, and nothing the
 * query sent.
 */
import { describe, expect, test } from "bun:test";
import {
  callbackFailure,
  listenForCallback,
  PAGE_HEADERS,
  type PageOutcome,
  page,
} from "../../../../../src/main/features/remote/loopback";
import { resources } from "../../../../../src/shared/i18n";

const ko = resources.ko.settings.remote.account;
const en = resources.en.settings.remote.account;

/** The page's visible text, tags dropped. */
const textOf = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("what a callback says", () => {
  test.each([
    ["code=c1&state=s", undefined],
    ["state=s", "failed"],
    ["code=&state=s", "failed"],
    ["code=c1&error=server_error", "server_error"],
    ["error=not_invited", "not_invited"],
    ["error=not_invited&access=pending", "pending_approval"],
    ["error=not_invited&access=rejected", "rejected"],
    ["error=not_invited&access=suspended", "suspended"],
    ["error=not_invited&access=closed", "closed"],
    ["error=not_invited&access=waitlisted", "failed"],
    ["error=not_invited&access=", "failed"],
    ["error=not_invited&access=__proto__", "failed"],
    ["error=access_denied", "access_denied"],
    ["error=unverified_email", "unverified_email"],
    ["error=server_error", "server_error"],
    ["error=too_many_devices", "failed"],
    ["error=something_new", "failed"],
  ] as const)("%s is %s", (query, failure) => {
    expect(callbackFailure(new URLSearchParams(query))).toBe(failure);
  });
});

describe("the page", () => {
  test.each([
    ["signed-in", ko.browser.signedIn.title, ko.browser.signedIn.body, false],
    ["pending_approval", ko.failure.pending_approval.title, ko.failure.pending_approval.body, true],
    ["closed", ko.failure.closed.title, ko.failure.closed.body, true],
    ["not_invited", ko.failure.not_invited.title, ko.failure.not_invited.body, true],
    ["rejected", ko.failure.rejected.title, ko.failure.rejected.body, false],
    ["suspended", ko.failure.suspended.title, ko.failure.suspended.body, false],
    ["access_denied", ko.failure.access_denied.title, ko.failure.access_denied.body, false],
    [
      "unverified_email",
      ko.failure.unverified_email.title,
      ko.failure.unverified_email.body,
      false,
    ],
    ["server_error", ko.failure.server_error.title, ko.failure.server_error.body, false],
    ["failed", ko.failure.failed.title, ko.failure.failed.body, false],
  ] as const)("says %s in the app's words", (outcome, title, body, approvedOnly) => {
    const html = page(outcome as PageOutcome, "ko");
    expect(html).toStartWith('<!doctype html><html lang="ko">');
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<p class="body">${body}</p>`);
    expect(html).toContain(ko.browser.closeTab);
    expect(html.includes(ko.approvedOnly)).toBe(approvedOnly);
    expect(html).not.toContain("<script");
    // Everything it shows is the app's own: no address, no link, no image to load.
    expect(html).not.toMatch(/(?:src|href)=/);
  });

  test("has these words, title first, in the order the eye reads them", () => {
    expect(textOf(page("pending_approval", "ko"))).toBe(
      [
        `${ko.failure.pending_approval.title} · NexusCode`,
        "NexusCode",
        ko.failure.pending_approval.title,
        ko.approvedOnly,
        ko.failure.pending_approval.body,
        ko.browser.closeTab,
      ].join(" "),
    );
  });

  test("is in English when the app is", () => {
    const html = page("pending_approval", "en");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<h1>${en.failure.pending_approval.title}</h1>`);
    expect(html).toContain(en.approvedOnly);
    expect(html).toContain("You can close this tab");
  });

  test("escapes its words", () => {
    // The not_invited body has an apostrophe in English.
    expect(page("not_invited", "en")).toContain("server&#39;s admin");
  });

  test("follows the system's light and dark", () => {
    const html = page("signed-in", "ko");
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain("color-scheme:light dark");
  });
});

describe("the callback's answer", () => {
  test("sends the page with headers that keep it to itself", async () => {
    const listener = await listenForCallback(5_000, () => "ko");
    const res = await fetch(`${listener.redirectUri}?code=c1&state=s1`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(res.headers.get("content-type")).toBe(PAGE_HEADERS["content-type"]);
    expect(await res.text()).toBe(page("signed-in", "ko"));
    expect(await listener.result).toEqual({ code: "c1", error: undefined, state: "s1" });
  });

  test("shows a status it does not know as a plain failure, and nothing of the query", async () => {
    const listener = await listenForCallback(5_000, () => "en");
    const injected = "<script>alert(1)</script>";
    const query = new URLSearchParams({
      error: "not_invited",
      access: injected,
      error_description: "Your account <b>is</b> on hold",
      state: "s<i>1",
    });
    const res = await fetch(`${listener.redirectUri}?${query}`);
    const html = await res.text();
    expect(html).toBe(page("failed", "en"));
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("on hold");
    expect(html).not.toContain("s<i>1");
    expect(await listener.result).toEqual({
      failure: "failed",
      error: "not_invited",
      state: "s<i>1",
    });
  });

  test("shows the signup status the server sent", async () => {
    const listener = await listenForCallback(5_000, () => "ko");
    const res = await fetch(`${listener.redirectUri}?error=not_invited&access=closed&state=s1`);
    expect(await res.text()).toBe(page("closed", "ko"));
    expect(await listener.result).toMatchObject({ failure: "closed", state: "s1" });
  });
});
