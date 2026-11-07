import { afterEach, describe, expect, test } from "bun:test";
import { OAuthCallbacks } from "../../../../src/main/features/chat/oauth-callback";

/** The page's address, on the loopback address it is served on. */
function onLoopback(redirectUri: string, search = ""): string {
  return `${redirectUri.replace("//localhost:", "//127.0.0.1:")}${search}`;
}

describe("OAuthCallbacks", () => {
  let callbacks: OAuthCallbacks;
  afterEach(() => callbacks.dispose());

  test("hands back the address the browser came back to", async () => {
    callbacks = new OAuthCallbacks();
    const { id, redirectUri } = await callbacks.listen();
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    const back = callbacks.wait(id);
    const res = await fetch(onLoopback(redirectUri, "?code=abc&state=xyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("NexusCode");
    expect(await back).toBe(`${redirectUri}?code=abc&state=xyz`);
  });

  test("keeps it for a wait that comes after it", async () => {
    callbacks = new OAuthCallbacks();
    const { id, redirectUri } = await callbacks.listen();
    await fetch(onLoopback(redirectUri, "?code=1"));
    expect(await callbacks.wait(id)).toBe(`${redirectUri}?code=1`);
  });

  test("answers only its own path, and only once", async () => {
    callbacks = new OAuthCallbacks();
    const { id, redirectUri } = await callbacks.listen();
    const other = await fetch(onLoopback(redirectUri.replace("/callback", "/elsewhere")));
    expect(other.status).toBe(404);

    const back = callbacks.wait(id);
    await fetch(onLoopback(redirectUri, "?code=first"));
    expect(await back).toBe(`${redirectUri}?code=first`);
    // The page is closed once answered.
    const second = await fetch(onLoopback(redirectUri, "?code=second")).then(
      (res) => res.status,
      () => "closed",
    );
    expect([404, "closed"]).toContain(second);
  });

  test("a cancelled or timed out sign-in comes back with nothing", async () => {
    callbacks = new OAuthCallbacks(50);
    const cancelled = await callbacks.listen();
    const back = callbacks.wait(cancelled.id);
    callbacks.cancel(cancelled.id);
    expect(await back).toBeNull();
    expect(await callbacks.wait(cancelled.id)).toBeNull();

    const timedOut = await callbacks.listen();
    expect(await callbacks.wait(timedOut.id)).toBeNull();
    expect(await callbacks.wait("unknown")).toBeNull();
  });

  test("each sign-in has its own page", async () => {
    callbacks = new OAuthCallbacks();
    const a = await callbacks.listen();
    const b = await callbacks.listen();
    expect(a.redirectUri).not.toBe(b.redirectUri);
    const backB = callbacks.wait(b.id);
    await fetch(onLoopback(b.redirectUri, "?code=b"));
    expect(await backB).toBe(`${b.redirectUri}?code=b`);
    callbacks.cancel(a.id);
    expect(await callbacks.wait(a.id)).toBeNull();
  });
});
