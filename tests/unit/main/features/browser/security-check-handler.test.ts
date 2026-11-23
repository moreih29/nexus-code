import { mock as bunMock, describe, expect, mock, test } from "bun:test";

bunMock.module("electron", () => ({
  WebContentsView: class {},
}));

const { installPermissionHandler } = await import(
  "../../../../../src/main/features/browser/security"
);

type PermissionSource = {
  isMainFrame?: boolean;
  requestingUrl?: string;
  securityOrigin?: string;
};

type FakeCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin?: string,
  details?: PermissionSource,
) => boolean;

type FakeRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (ok: boolean) => void,
  details?: PermissionSource,
) => void;

interface FakeSession {
  _checkHandler: FakeCheckHandler | null;
  _requestHandler: FakeRequestHandler | null;
  setPermissionCheckHandler(h: FakeCheckHandler): void;
  setPermissionRequestHandler(h: FakeRequestHandler): void;
}

function makeFakeSession(): FakeSession {
  return {
    _checkHandler: null,
    _requestHandler: null,
    setPermissionCheckHandler(h) {
      this._checkHandler = h;
    },
    setPermissionRequestHandler(h) {
      this._requestHandler = h;
    },
  };
}

function makeFakeWebContents(url: string): unknown {
  return {
    getURL: () => url,
    id: 1,
  };
}

function makeDepsForDecision(decision: "allow" | "ask" | "block") {
  const fakePromptManager = {
    handlePermissionRequest: mock(() => {}),
    disposeByWebContents: mock(() => {}),
  };

  if (decision === "allow") {
    return {
      getGlobalGrant: () => true,
      getRemembered: () => null as "allow" | "block" | null,
      promptManager: fakePromptManager,
    };
  }

  if (decision === "ask") {
    return {
      getGlobalGrant: () => false,
      getRemembered: () => null as "allow" | "block" | null,
      promptManager: fakePromptManager,
    };
  }

  return {
    getGlobalGrant: () => false,
    getRemembered: () => "block" as "allow" | "block" | null,
    promptManager: fakePromptManager,
  };
}

const ATTRIBUTABLE_ORIGIN_URL = "https://example.com/page";
const PROMPT_PERMISSION = "geolocation";

describe("installPermissionHandler (full-deps) — check handler", () => {
  test("allow decision → check handler returns true", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    expect(session._checkHandler).not.toBeNull();
    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(true);
  });

  test("ask decision → check handler returns false", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("ask");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });

  test("block decision → check handler returns false", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("block");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });

  test("null webContents → check handler returns false (origin deny)", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const result = session._checkHandler!(null, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });
});

describe("installPermissionHandler (full-deps) — opaque origin deny", () => {
  function installAndCheck(url: string, permission: string): boolean {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );
    const wc = makeFakeWebContents(url);
    return session._checkHandler!(wc, permission);
  }

  test("about:blank URL → origin 'null' → denied (false)", () => {
    expect(installAndCheck("about:blank", PROMPT_PERMISSION)).toBe(false);
  });

  test("data: URL → origin 'null' → denied (false)", () => {
    expect(installAndCheck("data:text/html,hi", PROMPT_PERMISSION)).toBe(false);
  });

  test("empty URL → denied (false)", () => {
    expect(installAndCheck("", PROMPT_PERMISSION)).toBe(false);
  });

  test("https:// URL → attributable origin → NOT denied by safeGetOrigin", () => {
    expect(installAndCheck(ATTRIBUTABLE_ORIGIN_URL, PROMPT_PERMISSION)).toBe(true);
  });
});

describe("installPermissionHandler (full-deps) — prompt lifetime", () => {
  function makeTrackedWebContents(id: number) {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const add = (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    };
    return {
      id,
      getURL: () => ATTRIBUTABLE_ORIGIN_URL,
      on: add,
      once: add,
      emit(event: string, ...args: unknown[]) {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      },
    };
  }

  test("checks and prompts for the requesting frame instead of the top document", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("ask");
    const frameOrigin = "https://component.test";
    installPermissionHandler(
      session as unknown as import("electron").Session,
      {
        ...deps,
        getRemembered: (_workspace, origin) =>
          origin === new URL(ATTRIBUTABLE_ORIGIN_URL).origin ? "allow" : null,
        promptManager: deps.promptManager as never,
      },
      "ws-1",
    );
    const wc = makeTrackedWebContents(7102);
    const frame = { isMainFrame: false, requestingUrl: `${frameOrigin}/widget` };
    expect(session._checkHandler?.(wc, PROMPT_PERMISSION, frameOrigin, frame)).toBe(false);
    expect(
      session._checkHandler?.(wc, PROMPT_PERMISSION, new URL(ATTRIBUTABLE_ORIGIN_URL).origin, {
        isMainFrame: true,
      }),
    ).toBe(true);

    session._requestHandler?.(wc, PROMPT_PERMISSION, () => {}, frame);
    expect(deps.promptManager.handlePermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ origin: frameOrigin, decision: "ask" }),
      expect.any(Function),
    );
    wc.emit("destroyed");
  });

  test("denies a missing or opaque frame origin without falling back to the top document", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as never,
      "ws-1",
    );
    const wc = makeTrackedWebContents(7103);
    const opaque = {
      isMainFrame: false,
      securityOrigin: "null",
      requestingUrl: ATTRIBUTABLE_ORIGIN_URL,
    };
    expect(session._checkHandler?.(wc, PROMPT_PERMISSION, "null", opaque)).toBe(false);

    const reply = mock((_allowed: boolean) => {});
    session._requestHandler?.(wc, PROMPT_PERMISSION, reply, opaque);
    session._requestHandler?.(wc, PROMPT_PERMISSION, reply, { isMainFrame: false });
    expect(reply.mock.calls).toEqual([[false], [false]]);
    expect(deps.promptManager.handlePermissionRequest).not.toHaveBeenCalled();
  });

  test("disposes the page's prompts when its main frame navigates or it is destroyed", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("ask");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as never,
      "ws-1",
    );
    const wc = makeTrackedWebContents(7101);

    session._requestHandler?.(wc, PROMPT_PERMISSION, () => {});
    session._requestHandler?.(wc, PROMPT_PERMISSION, () => {});
    expect(deps.promptManager.handlePermissionRequest).toHaveBeenCalledTimes(2);

    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(deps.promptManager.disposeByWebContents).not.toHaveBeenCalled();

    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(deps.promptManager.disposeByWebContents).toHaveBeenCalledTimes(1);
    expect(deps.promptManager.disposeByWebContents).toHaveBeenCalledWith(7101);

    wc.emit("destroyed");
    expect(deps.promptManager.disposeByWebContents).toHaveBeenCalledTimes(2);
  });
});
