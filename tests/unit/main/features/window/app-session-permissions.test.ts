import { describe, expect, test } from "bun:test";
import type { Session } from "electron";
import { installAppSessionPermissions } from "../../../../../src/main/features/window/app-session-permissions";

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame: boolean; requestingUrl: string },
) => void;
type CheckHandler = (
  webContents: unknown,
  permission: string,
  origin: string,
  details: { isMainFrame: boolean },
) => boolean;

function install() {
  let request: RequestHandler | undefined;
  let check: CheckHandler | undefined;
  const session = {
    setPermissionRequestHandler: (h: RequestHandler) => {
      request = h;
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      check = h;
    },
  } as unknown as Session;
  installAppSessionPermissions(session);
  if (!request || !check) throw new Error("handlers not installed");
  const requestFn = request;
  const ask = (permission: string, isMainFrame: boolean) => {
    let granted: boolean | undefined;
    requestFn(
      null,
      permission,
      (g) => {
        granted = g;
      },
      { isMainFrame, requestingUrl: isMainFrame ? "file:///app/index.html" : "about:srcdoc" },
    );
    return granted;
  };
  return { ask, check };
}

describe("installAppSessionPermissions", () => {
  test("keeps granting the app UI's top frame", () => {
    const { ask, check } = install();
    expect(ask("openExternal", true)).toBe(true);
    expect(ask("media", true)).toBe(true);
    expect(check(null, "media", "file://", { isMainFrame: true })).toBe(true);
  });

  test("denies previewed subframes OS URL handlers and device access", () => {
    const { ask, check } = install();
    expect(ask("openExternal", false)).toBe(false);
    expect(ask("media", false)).toBe(false);
    expect(ask("geolocation", false)).toBe(false);
    expect(ask("notifications", false)).toBe(false);
    expect(check(null, "media", "null", { isMainFrame: false })).toBe(false);
  });

  test("lets subframes write the clipboard, as Chrome does without a prompt", () => {
    const { ask, check } = install();
    expect(ask("clipboard-sanitized-write", false)).toBe(true);
    expect(check(null, "clipboard-sanitized-write", "null", { isMainFrame: false })).toBe(true);
  });
});
