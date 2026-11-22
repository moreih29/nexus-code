/**
 * The page the browser shows once it is back from the sign-in: the app's own
 * words for how the sign-in ended (it waits for the app, for a while), in the
 * app's language, and nothing the query sent.
 */
import { describe, expect, test } from "bun:test";
import {
  callbackFailure,
  listenForCallback,
  notInvitedFailure,
  PAGE_HEADERS,
  type PageOutcome,
  page,
} from "../../../../../src/main/features/remote/loopback";
import { resources } from "../../../../../src/shared/i18n";
import { SIGN_IN_HELP_FAILURES } from "../../../../../src/shared/remote/account";

const ko = resources.ko.settings.remote.account;
const en = resources.en.settings.remote.account;
const SIGN_IN_HELP_KO = "https://nexuscode.gradiendo.com/support/#sign-in";
const SIGN_IN_HELP_EN = "https://nexuscode.gradiendo.com/en/support/#sign-in";

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

describe("why a not_invited refusal turned the account away", () => {
  test.each([
    [undefined, "not_invited"],
    [null, "not_invited"],
    ["suspended", "suspended"],
    ["pending", "pending_approval"],
    ["Suspended", "failed"],
    ["toString", "failed"],
    [5, "failed"],
    [{ access: "suspended" }, "failed"],
  ] as const)("access %p is %s", (access, failure) => {
    expect(notInvitedFailure(access)).toBe(failure);
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
    ["invalid_grant", ko.failure.invalid_grant.title, ko.failure.invalid_grant.body, false],
    ["rate_limited", ko.failure.rate_limited.title, ko.failure.rate_limited.body, false],
    [
      "too_many_devices",
      ko.failure.too_many_devices.title,
      ko.failure.too_many_devices.body,
      false,
    ],
    ["mismatch", ko.failure.mismatch.title, ko.failure.mismatch.body, false],
    ["failed", ko.failure.failed.title, ko.failure.failed.body, false],
    ["in-app", ko.browser.continueInApp.title, ko.browser.continueInApp.body, false],
  ] as const)("says %s in the app's words", (outcome, title, body, approvedOnly) => {
    const html = page(outcome as PageOutcome, "ko");
    expect(html).toStartWith('<!doctype html><html lang="ko">');
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<p class="body">${body}</p>`);
    expect(html).toContain(ko.browser.closeTab);
    expect(html.includes(ko.approvedOnly)).toBe(approvedOnly);
    expect(html).not.toContain("<script");
    // Everything it shows is the app's own: no address, no image to load, and no link but
    // support's for a failure it explains, at the app's own address.
    const help = (SIGN_IN_HELP_FAILURES as readonly string[]).includes(outcome);
    expect(html.match(/(?:src|href)=/g) ?? []).toHaveLength(help ? 1 : 0);
    expect(html.includes(`<a href="${SIGN_IN_HELP_KO}"`)).toBe(help);
  });

  test("has these words, title first, in the order the eye reads them", () => {
    expect(textOf(page("pending_approval", "ko"))).toBe(
      [
        `${ko.failure.pending_approval.title} · NexusCode`,
        "NexusCode",
        ko.failure.pending_approval.title,
        ko.approvedOnly,
        ko.failure.pending_approval.body,
        ko.learnMore,
        ko.browser.closeTab,
      ].join(" "),
    );
  });

  test.each([
    ["pending_approval", "ko", SIGN_IN_HELP_KO, "자세히"],
    ["closed", "en", SIGN_IN_HELP_EN, "Learn more"],
    ["not_invited", "ko", SIGN_IN_HELP_KO, "자세히"],
    ["rejected", "en", SIGN_IN_HELP_EN, "Learn more"],
  ] as const)("links %s to support's sign-in section in %s", (outcome, language, url, label) => {
    const html = page(outcome, language);
    // A new tab the page does not reach back into, and no script to open it.
    expect(html).toContain(
      `<p class="more"><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a></p>`,
    );
    expect(html).not.toContain("<script");
  });

  test.each([
    "signed-in",
    "in-app",
    "suspended",
    "too_many_devices",
  ] as const)("does not link %s", (outcome) => {
    expect(page(outcome, "en")).not.toContain("<a ");
  });

  test.each([
    ["google", "ko", "승인되면 같은 Google 계정으로 다시 로그인하세요."],
    ["apple", "ko", "승인되면 같은 Apple 계정으로 다시 로그인하세요."],
    ["github", "en", "Once approved, sign in again with the same GitHub account."],
    // The dev sign-in has no name to give, and an app started anew knows none.
    ["dev", "ko", ko.failure.pending_approval.body],
    [undefined, "en", en.failure.pending_approval.body],
  ] as const)("names a pending approval's sign-in %s", (provider, language, body) => {
    expect(page("pending_approval", language, provider)).toContain(`<p class="body">${body}</p>`);
  });

  test("names the sign-in for a pending approval alone", () => {
    expect(page("closed", "en", "google")).toBe(page("closed", "en"));
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
    const shown = fetch(`${listener.redirectUri}?code=c1&state=s1`);
    expect(await listener.result).toEqual({ code: "c1", error: undefined, state: "s1" });
    listener.report("signed-in");
    const res = await shown;
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(res.headers.get("content-type")).toBe(PAGE_HEADERS["content-type"]);
    expect(await res.text()).toBe(page("signed-in", "ko"));
  });

  test("keeps those headers on a page with support's link, which they let open", async () => {
    const listener = await listenForCallback(5_000, () => "en");
    const shown = fetch(`${listener.redirectUri}?error=not_invited&access=rejected`);
    await listener.result.catch(() => {});
    listener.report("rejected");
    const res = await shown;
    expect(
      Object.fromEntries(Object.keys(PAGE_HEADERS).map((h) => [h, res.headers.get(h)])),
    ).toEqual(PAGE_HEADERS);
    // No directive governs where the page goes, so the link opens.
    expect(PAGE_HEADERS["content-security-policy"]).not.toMatch(/navigate-to|form-action|sandbox/);
    const html = await res.text();
    expect(html).toBe(page("rejected", "en"));
    expect(html).toContain(
      `<a href="${SIGN_IN_HELP_EN}" target="_blank" rel="noopener noreferrer">`,
    );
  });

  test("waits for the app to say how the sign-in ended", async () => {
    const listener = await listenForCallback(5_000, () => "en");
    let sent = false;
    const shown = fetch(`${listener.redirectUri}?code=c1&state=s1`).then((res) => {
      sent = true;
      return res.text();
    });
    // The callback is the sign-in's at once; the page is not sent until told.
    expect(await listener.result).toMatchObject({ code: "c1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toBe(false);
    listener.report("too_many_devices");
    expect(await shown).toBe(page("too_many_devices", "en"));
    // Shown again (a reload), it says the same at once; a later report changes nothing.
    listener.report("signed-in");
    const again = await fetch(`${listener.redirectUri}?code=c1&state=s1`);
    expect(await again.text()).toBe(page("too_many_devices", "en"));
  });

  test("says a pending approval's sign-in, as the app tells it", async () => {
    const listener = await listenForCallback(5_000, () => "ko");
    const shown = fetch(`${listener.redirectUri}?error=not_invited&access=pending&state=s1`);
    await listener.result;
    listener.report("pending_approval", "google");
    const html = await (await shown).text();
    expect(html).toBe(page("pending_approval", "ko", "google"));
    expect(html).toContain("같은 Google 계정");
  });

  test("past the wait, leaves the rest to the app", async () => {
    const listener = await listenForCallback(5_000, () => "ko", 30);
    const res = await fetch(`${listener.redirectUri}?code=c1&state=s1`);
    expect(await res.text()).toBe(page("in-app", "ko"));
    expect(await listener.result).toMatchObject({ code: "c1" });
    // The app tells too late: the page already said to look there.
    listener.report("signed-in");
  });

  test("leaves it to the app when the sign-in stopped without an outcome", async () => {
    const listener = await listenForCallback(5_000, () => "en");
    const shown = fetch(`${listener.redirectUri}?code=c1&state=s1`);
    await listener.result;
    listener.report("cancelled");
    expect(await (await shown).text()).toBe(page("in-app", "en"));
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
    const shown = fetch(`${listener.redirectUri}?${query}`);
    expect(await listener.result).toMatchObject({ failure: "failed" });
    listener.report("failed");
    const html = await (await shown).text();
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

  test("gives the signup status the server sent", async () => {
    const listener = await listenForCallback(5_000, () => "ko");
    const shown = fetch(`${listener.redirectUri}?error=not_invited&access=closed&state=s1`);
    expect(await listener.result).toMatchObject({ failure: "closed", state: "s1" });
    listener.report("closed");
    expect(await (await shown).text()).toBe(page("closed", "ko"));
  });
});
