import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CallbackResponse, OnBeforeRequestListenerDetails, WebContents } from "electron";
import {
  installLocalFileReadGuard,
  isScopedFilePath,
} from "../../../../../src/main/features/browser/local-files";
import { installNavigationGuards } from "../../../../../src/main/features/browser/security";

interface Frame {
  url: string;
  parent: Frame | null;
  detached: boolean;
}

type Request = OnBeforeRequestListenerDetails;
type Listener = (request: Request, finish: (response: CallbackResponse) => void) => void;

let nextId = 2000;

function makeSession() {
  let listener: Listener | undefined;
  return {
    webRequest: {
      onBeforeRequest: mock((_filter: unknown, handler: Listener) => {
        listener = handler;
      }),
    },
    request(details: Partial<Request>): boolean | undefined {
      if (!listener) throw new Error("file request guard not installed");
      let cancelled: boolean | undefined;
      listener(details as Request, (response) => {
        cancelled = response.cancel;
      });
      return cancelled;
    },
  };
}

class Contents extends EventEmitter {
  readonly id = nextId++;
  readonly mainFrame: Frame;

  constructor(
    readonly session: ReturnType<typeof makeSession>,
    url: string,
  ) {
    super();
    this.mainFrame = { url, parent: null, detached: false };
  }

  setWindowOpenHandler(): void {}

  asWebContents(): WebContents {
    return this as unknown as WebContents;
  }
}

describe("a browser tab's local file scope", () => {
  let root: string;
  let tab: Contents;
  let child: Frame;
  let session: ReturnType<typeof makeSession>;

  function url(file: string): string {
    return pathToFileURL(path.join(root, file)).href;
  }

  function request(
    resourceType: Request["resourceType"],
    target: string,
    overrides: Partial<Request> = {},
  ) {
    return session.request({
      resourceType,
      url: target,
      frame: tab.mainFrame as unknown as Request["frame"],
      webContents: tab.asWebContents(),
      initiatorOrigin: "file://",
      ...overrides,
    });
  }

  function frameNavigation(target: string, frame = child, initiator = tab.mainFrame): boolean {
    const preventDefault = mock(() => {});
    tab.emit("will-frame-navigate", {
      isMainFrame: false,
      url: target,
      frame,
      initiator,
      preventDefault,
    });
    return preventDefault.mock.calls.length > 0;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "nexus-browser-local-"));
    for (const file of [
      "site/index.html",
      "site/data.json",
      "site/inner/frame.html",
      "data.json",
      "sibling/data.json",
    ]) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    session = makeSession();
    tab = new Contents(session, url("site/index.html"));
    child = { url: "about:blank", parent: tab.mainFrame, detached: false };
    installLocalFileReadGuard(tab.asWebContents());
    installNavigationGuards(tab.asWebContents());
    tab.emit("did-navigate", {}, tab.mainFrame.url);
  });

  afterEach(() => {
    tab.emit("destroyed");
    rmSync(root, { recursive: true, force: true });
  });

  test("allows fetch, JSON modules and direct iframes under the HTML folder", () => {
    expect(request("xhr", url("site/data.json"))).toBe(false);
    expect(request("script", url("site/data.json"))).toBe(false);
    expect(request("xhr", url("site/inner/frame.html"))).toBe(false);
    expect(frameNavigation(url("site/inner/frame.html"))).toBe(false);
    expect(
      request("subFrame", url("site/inner/frame.html"), {
        frame: child as unknown as Request["frame"],
      }),
    ).toBe(false);
  });

  test("denies parent, sibling and dot-segment targets for reads and frames", () => {
    for (const target of [
      url("data.json"),
      url("sibling/data.json"),
      new URL("../data.json", tab.mainFrame.url).href,
    ]) {
      expect(request("xhr", target)).toBe(true);
      expect(request("script", target)).toBe(true);
      expect(request("subFrame", target)).toBe(true);
      expect(frameNavigation(target)).toBe(true);
    }
  });

  test("denies symlinks to files outside the real folder", () => {
    symlinkSync(path.join(root, "sibling"), path.join(root, "site/link"), "junction");
    expect(request("xhr", url("site/link/data.json"))).toBe(true);
    expect(frameNavigation(url("site/link/data.json"))).toBe(true);
  });

  test("keeps ordinary assets loadable and local objects blocked", () => {
    expect(request("mainFrame", url("site/index.html"))).toBe(false);
    expect(request("image", url("image.png"))).toBe(false);
    expect(request("stylesheet", url("site.css"))).toBe(false);
    expect(request("script", url("app.js"))).toBe(false);
    expect(request("object", url("site/inner/frame.html"))).toBe(true);
  });

  test("requires the current top document and does not grant its child or popup a scope", () => {
    const file = url("site/inner/frame.html");
    const popup = new Contents(session, url("site/index.html"));
    tab.emit("did-create-window", { webContents: popup });
    expect(
      request("xhr", file, {
        webContents: popup.asWebContents(),
        frame: popup.mainFrame as unknown as Request["frame"],
      }),
    ).toBe(true);
    expect(request("xhr", file, { frame: child as unknown as Request["frame"] })).toBe(true);
    expect(request("xhr", file, { frame: null })).toBe(true);
    expect(request("xhr", file, { initiatorOrigin: "https://example.com" })).toBe(true);
    expect(frameNavigation(file, child, child)).toBe(true);
    expect(frameNavigation(file, { url: "about:blank", parent: child, detached: false })).toBe(
      true,
    );

    const preventDefault = mock(() => {});
    tab.emit("will-redirect", { isMainFrame: false, url: file, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    tab.emit("will-navigate", { initiator: child, preventDefault }, url("data.json"));
    expect(preventDefault).toHaveBeenCalledTimes(2);
    popup.emit("will-redirect", { isMainFrame: true, url: file, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(3);
    popup.emit("destroyed");

    tab.mainFrame.url = "https://example.com/";
    expect(request("xhr", file)).toBe(true);
    expect(frameNavigation(file)).toBe(true);
  });

  test("only a new committed document changes the folder scope", () => {
    const data = url("site/data.json");
    tab.mainFrame.url += "#section";
    expect(request("xhr", data)).toBe(false);
    tab.mainFrame.url = url("site/inner/frame.html");
    expect(request("xhr", url("site/inner/frame.html"))).toBe(true);
    tab.emit("did-navigate", {}, tab.mainFrame.url);
    expect(request("xhr", url("site/inner/frame.html"))).toBe(false);
    expect(request("xhr", data)).toBe(true);
  });

  test("installs one session guard while checking each tab's own document", () => {
    const second = new Contents(session, url("site/inner/frame.html"));
    installLocalFileReadGuard(second.asWebContents());
    second.emit("did-navigate", {}, second.mainFrame.url);
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(
      request("xhr", url("site/data.json"), {
        webContents: second.asWebContents(),
        frame: second.mainFrame as unknown as Request["frame"],
      }),
    ).toBe(true);
    expect(request("xhr", url("site/data.json"))).toBe(false);
  });
});

describe("real filesystem scope boundaries", () => {
  test("excludes the home folder and filesystem root themselves", () => {
    const home = "/home/person";
    expect(isScopedFilePath(home, `${home}/.ssh/config`, home, path.posix)).toBe(false);
    expect(isScopedFilePath("/", "/etc/hosts", home, path.posix)).toBe(false);
    expect(isScopedFilePath(`${home}/project`, `${home}/project/data.json`, home, path.posix)).toBe(
      true,
    );
  });

  test("excludes any ancestor of the POSIX home folder", () => {
    expect(
      isScopedFilePath("/Users", "/Users/person/.ssh/config", "/Users/person", path.posix),
    ).toBe(false);
    expect(
      isScopedFilePath(
        "/srv",
        "/srv/profiles/person/.ssh/config",
        "/srv/profiles/person",
        path.posix,
      ),
    ).toBe(false);
    expect(
      isScopedFilePath("/Users", "/Users/site/data.json", "/Users-other/person", path.posix),
    ).toBe(true);
  });

  test("excludes Windows home ancestors even when drive and directory case differ", () => {
    expect(
      isScopedFilePath(
        "c:\\uSeRs",
        "c:\\users\\person\\.ssh\\config",
        "C:\\Users\\Person",
        path.win32,
      ),
    ).toBe(false);
  });

  test("uses Windows case folding and excludes other drives, home and drive roots", () => {
    const home = "C:\\Users\\Person";
    const folder = `${home}\\Project`;
    expect(
      isScopedFilePath(folder, "c:\\users\\person\\PROJECT\\Data.json", home, path.win32),
    ).toBe(true);
    expect(
      isScopedFilePath(folder, "D:\\Users\\Person\\Project\\data.json", home, path.win32),
    ).toBe(false);
    expect(isScopedFilePath(folder, `${home}\\Project-other\\data.json`, home, path.win32)).toBe(
      false,
    );
    expect(isScopedFilePath("c:\\users\\person", `${home}\\.ssh\\config`, home, path.win32)).toBe(
      false,
    );
    expect(isScopedFilePath("C:\\", "c:\\data.json", home, path.win32)).toBe(false);
  });
});
