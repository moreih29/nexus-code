/**
 * Drives the app's browser tabs for nexus browser snapshot, inspect, click,
 * fill, type, press, screenshot, eval, console and wait, through each tab's own
 * DevTools protocol connection (webContents.debugger). It works on tabs
 * that are not shown, too: Chromium takes input and paints screenshots for
 * a hidden page. A tab never shown has no size, though, so it is given one
 * first (see HIDDEN_SIZE), and a hidden page draws nothing by itself, while
 * Chromium sends a click only to a page that has drawn, so one is drawn
 * before each click on it (see paint). Off macOS a page out of the window
 * cannot draw at all, so it is put in a hidden window for a screenshot or a
 * click (see parked).
 *
 * Elements are named by a ref from the last snapshot ("e12") or a CSS
 * selector that matches one element. Input is real input events, so pages
 * see clicks and typing as a person's.
 */
import { BaseWindow, type Input, screen, type View, type WebContents } from "electron";
import { CliError } from "../context";
import { type ConsoleEntry, type ConsoleLog, watchConsole } from "./console-log";
import { DrivenTabs, saveCommandDownload } from "./downloads";
import { type KeyPress, parseBrowserKey } from "./keys";
import {
  type Box,
  cleanPicked,
  DESCRIBE_PICKED,
  type PickCancel,
  type PickedDetails,
  type PickedElement,
  type PickResult,
} from "./pick";
import { type AxNode, buildSnapshot, roleAndName, type SnapshotRef } from "./snapshot";

export interface PageInfo {
  readonly url: string;
  readonly title: string;
  /**
   * The file the tab's last navigation downloads instead of showing, as one
   * served as application/octet-stream. The tab keeps the page it had, or
   * none.
   */
  readonly download?: PageDownload;
}

export interface PageDownload {
  readonly url: string;
  /** Where it is saved, a command's download being kept out of the user's Downloads. */
  readonly file: string;
  readonly type: string;
}

export interface PageSnapshot extends PageInfo {
  readonly text: string;
  readonly omitted: number;
}

/** What an action did, said for people, and where the page is after it. */
export interface ActionResult extends PageInfo {
  readonly text: string;
  readonly navigated: boolean;
}

/** Where a page was before an action: its URL and how many navigations it had started. */
interface PageMark {
  readonly url: string;
  readonly navigations: number;
}

/** Where browser scroll goes: a way and how far, an end, or to an element. */
export type BrowserScroll =
  | {
      readonly kind: "by";
      readonly way: "up" | "down" | "left" | "right";
      /** In CSS pixels; most of a view's worth when absent. */
      readonly amount?: number;
    }
  | { readonly kind: "end"; readonly end: "top" | "bottom" }
  | { readonly kind: "to"; readonly target: string };

export type BrowserWaitCondition =
  | { readonly kind: "load" }
  | { readonly kind: "text"; readonly text: string; readonly gone: boolean }
  | { readonly kind: "selector"; readonly selector: string; readonly gone: boolean }
  | { readonly kind: "url"; readonly pattern: RegExp };

/** A browser tab's page and the view that holds it, as the browser registry has them. */
export interface BrowserPage {
  readonly contents: WebContents;
  readonly view: View;
  /** Whether the view is in the window; a tab not shown is not. */
  readonly active: boolean;
}

export interface BrowserDriver {
  snapshot(tabId: string, options: { maxLines: number; within?: string }): Promise<PageSnapshot>;
  click(
    tabId: string,
    target: string,
    options: { double: boolean; force: boolean },
  ): Promise<ActionResult>;
  /** Moves the mouse over an element, as hovering it does. */
  hover(tabId: string, target: string, options: { force: boolean }): Promise<ActionResult>;
  /** Drags one element onto another with the mouse, HTML drag and drop included. */
  drag(tabId: string, from: string, to: string): Promise<ActionResult>;
  /** Scrolls the page, or the element `within` names. */
  scroll(tabId: string, scroll: BrowserScroll, within?: string): Promise<ActionResult>;
  fill(tabId: string, target: string, text: string): Promise<ActionResult>;
  type(tabId: string, text: string, target?: string): Promise<ActionResult>;
  press(tabId: string, keys: readonly string[]): Promise<ActionResult>;
  /** A PNG, base64: of what the tab shows, the whole page, or one element. */
  screenshot(tabId: string, options: { full: boolean; element?: string }): Promise<string>;
  /** What an element is, as pick tells it, with a picture of it, scrolled into view. */
  inspect(tabId: string, target: string): Promise<PickedElement>;
  evaluate(tabId: string, expression: string): Promise<unknown>;
  console(tabId: string, clear: boolean): readonly ConsoleEntry[];
  /** Resolves true once `condition` holds, false if it did not in time. */
  waitFor(tabId: string, condition: BrowserWaitCondition, timeoutMs: number): Promise<boolean>;
  /**
   * Waits for a load the last command may have started, then says where the
   * tab is; null when the tab has no page yet, as a tab not shown since it
   * was opened behind.
   */
  settle(tabId: string): Promise<PageInfo | null>;
  /**
   * Highlights what is under the mouse in a shown tab until the user clicks
   * an element, which picks it instead of clicking it, or the pick ends
   * without one: Esc, the timeout, `signal`, or the tab hidden, closed or
   * gone to another page.
   */
  pick(tabId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PickResult>;
}

/** Objects a command takes from the page, released when it is done. */
const OBJECT_GROUP = "nexus-cli";
/** How long an action gives the page to start loading a new one. */
const NAVIGATION_START_MS = 300;
const LOAD_MS = 15_000;
const EVALUATE_MS = 60_000;
/** How long a screenshot, or a click on a page not shown, waits for the page to draw. */
const DRAW_MS = 30_000;
const WAIT_POLL_MS = 250;
/** How long settle waits for a tab just opened to get its page. */
const PAGE_START_MS = 3_000;
/** How long settle waits, after a load that showed no page, for its download. */
const DOWNLOAD_START_MS = 1_000;
const DOWNLOAD_POLL_MS = 50;
/**
 * The size a tab never shown gets, so its page lays out and takes clicks.
 * The app gives it its real size once it is shown.
 */
const HIDDEN_SIZE = { width: 1280, height: 800 };
/** The tallest a --full screenshot is taken, in CSS pixels. */
const MAX_FULL_HEIGHT = 16_384;
/** How long a pick waits for its tab, just asked to be shown, to show. */
const SHOW_MS = 3_000;
/** How a pick highlights the element under the mouse: as DevTools' element picker does. */
const PICK_HIGHLIGHT = {
  showInfo: true,
  showAccessibilityInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

interface TabState {
  refs: ReadonlyMap<string, SnapshotRef>;
  /** Page loads so far, and how many there had been at the last snapshot. */
  loads: number;
  snapshotLoads: number;
}

interface Located {
  readonly objectId: string;
  readonly backendNodeId: number;
  /** As output names it: `button "Sign in" (e4)`. */
  readonly label: string;
}

interface RemoteObject {
  readonly type: string;
  readonly subtype?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly objectId?: string;
  readonly description?: string;
}

interface EvaluateResult {
  readonly result: RemoteObject;
  readonly exceptionDetails?: { readonly text: string; readonly exception?: RemoteObject };
}

/** Runs in the page on the element: readies it for fill, or says why it cannot be. */
const PREPARE_FILL = `function (text) {
  const el = this;
  if (el instanceof HTMLSelectElement) {
    const options = [...el.options];
    const wanted = text.trim().toLowerCase();
    const pick =
      options.find((o) => o.value === text) ||
      options.find((o) => o.label === text) ||
      options.find((o) => o.label.trim().toLowerCase() === wanted);
    if (!pick) return { error: "it has no option " + JSON.stringify(text) + "; it has " + options.map((o) => JSON.stringify(o.label)).join(", ") };
    el.value = pick.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { kind: "set", value: pick.label };
  }
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(type)) {
      return { error: "a " + type + " input takes no text; use nexus browser click" };
    }
    if (el.disabled || el.readOnly) return { error: "it is disabled or read-only" };
    if (["date", "time", "datetime-local", "month", "week", "color", "range"].includes(type)) {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { kind: "set", value: el.value };
    }
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return { error: "it is disabled or read-only" };
    el.focus();
    el.select();
    return { kind: "text" };
  }
  if (el.isContentEditable) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { kind: "text" };
  }
  return { error: "it is not a text field, a select or an editable element" };
}`;

/** Runs in the page on the element: whether `hit` is it or inside it, shadow roots included. */
const CONTAINS = `function (hit) {
  for (let node = hit; node; node = node.parentNode || node.host) if (node === this) return true;
  return false;
}`;

/** Runs in the page on a node: a short CSS-like name for messages. */
const DESCRIBE = `function () {
  if (this.nodeType !== 1) return this.nodeName.toLowerCase();
  const id = this.id ? "#" + this.id : "";
  const cls = typeof this.className === "string" && this.className.trim()
    ? "." + this.className.trim().split(/\\s+/).slice(0, 3).join(".")
    : "";
  return "<" + this.localName + id + cls + ">";
}`;

/** Where an element is on the page, for a picture of it alone; null when it has no size. */
const ELEMENT_CLIP = `function () {
  const r = this.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
}`;

/**
 * Scrolls the element, or the page when it is the document, and says where
 * it is after; `how` is a way and how far, or an end. Instant, whatever the
 * page's scroll-behavior.
 */
const SCROLL = `function (how) {
  const page = this.nodeType === 9;
  const box = page ? document.scrollingElement || document.documentElement : this;
  const view = { w: page ? innerWidth : box.clientWidth, h: page ? innerHeight : box.clientHeight };
  const before = { x: box.scrollLeft, y: box.scrollTop };
  if (how.end === "top") box.scrollTo({ top: 0, behavior: "instant" });
  else if (how.end === "bottom") box.scrollTo({ top: box.scrollHeight, behavior: "instant" });
  else {
    const across = how.way === "left" || how.way === "right";
    const step = how.amount ?? Math.round((across ? view.w : view.h) * 0.8);
    const sign = how.way === "up" || how.way === "left" ? -1 : 1;
    box.scrollBy({ left: across ? sign * step : 0, top: across ? 0 : sign * step, behavior: "instant" });
  }
  return {
    moved: { x: box.scrollLeft - before.x, y: box.scrollTop - before.y },
    at: { x: box.scrollLeft, y: box.scrollTop },
    max: { x: box.scrollWidth - box.clientWidth, y: box.scrollHeight - box.clientHeight },
  };
}`;

/** Where a scroll left the page or the element. */
interface Scrolled {
  readonly moved: { readonly x: number; readonly y: number };
  readonly at: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

/** How far a drag goes before the page sees it as a drag, as a hand's would. */
const DRAG_START_PX = 8;
/** How long a page has to start an HTML drag once the mouse moves. */
const DRAG_INTERCEPT_MS = 250;
/** Moves between the two points of a drag, for pages that follow the mouse. */
const DRAG_STEPS = 5;

function label(ref: SnapshotRef, name: string): string {
  return `${ref.role}${ref.name === "" ? "" : ` ${JSON.stringify(ref.name)}`} (${name})`;
}

function once(
  contents: WebContents,
  event: "did-start-loading" | "did-stop-loading",
  ms: number,
): Promise<boolean> {
  const emitter: NodeJS.EventEmitter = contents;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      emitter.removeListener(event, done);
      resolve(false);
    }, ms);
    emitter.once(event, done);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CdpBrowserDriver implements BrowserDriver {
  private readonly states = new WeakMap<WebContents, TabState>();
  private readonly consoles = new Map<string, { contents: WebContents; log: ConsoleLog }>();
  /** The pick going on in a tab. */
  private readonly picking = new Map<string, PickControl>();
  /** What each tab's last navigation downloaded instead of showing. */
  private readonly downloads = new WeakMap<WebContents, PageDownload>();
  /** Tabs whose last navigation has not shown a page, or did not. */
  private readonly uncommitted = new WeakSet<WebContents>();
  /** Tabs a command drives, whose downloads are the command's. */
  private readonly driven = new DrivenTabs<WebContents>();
  /** How many navigations each tab has started, to tell an action's own. */
  private readonly navigations = new WeakMap<WebContents, number>();

  constructor(
    private readonly pageOf: (tabId: string) => BrowserPage | undefined,
    private readonly mac = process.platform === "darwin",
  ) {}

  /**
   * Starts keeping `tabId`'s console, and what its navigations download;
   * called as each browser tab is created.
   */
  watch(tabId: string, contents: WebContents): void {
    this.consoles.set(tabId, { contents, log: watchConsole(contents) });
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.downloads.delete(contents);
      this.uncommitted.add(contents);
      this.navigations.set(contents, (this.navigations.get(contents) ?? 0) + 1);
    });
    contents.on("did-navigate", () => this.uncommitted.delete(contents));
    // Tabs share a session, which tells every tab's downloads.
    const session = contents.session;
    const onDownload = (_event: Electron.Event, item: Electron.DownloadItem, from: WebContents) => {
      if (from !== contents) return;
      const file = this.driven.drives(contents)
        ? saveCommandDownload(item)
        : item.getFilename();
      this.downloads.set(contents, { url: item.getURL(), file, type: item.getMimeType() });
    };
    session.on("will-download", onDownload);
    contents.once("destroyed", () => {
      session.removeListener("will-download", onDownload);
      if (this.consoles.get(tabId)?.contents === contents) this.consoles.delete(tabId);
    });
  }

  private contents(tabId: string): WebContents {
    const page = this.pageOf(tabId);
    if (!page || page.contents.isDestroyed()) {
      throw new CliError('the browser tab has no page yet; show it once with "nexus tab show"');
    }
    if (page.contents.isCrashed())
      throw new CliError("the browser tab's page has crashed; reload it");
    if (!page.active) {
      const bounds = page.view.getBounds();
      if (bounds.width === 0 || bounds.height === 0)
        page.view.setBounds({ x: 0, y: 0, ...HIDDEN_SIZE });
    }
    return page.contents;
  }

  private state(contents: WebContents): TabState {
    let state = this.states.get(contents);
    if (!state) {
      const created: TabState = { refs: new Map(), loads: 0, snapshotLoads: 0 };
      contents.on("did-navigate", () => {
        created.loads += 1;
      });
      this.states.set(contents, created);
      state = created;
    }
    return state;
  }

  private async send<T>(contents: WebContents, method: string, params: object = {}): Promise<T> {
    const debug = contents.debugger;
    if (!debug.isAttached()) {
      try {
        debug.attach("1.3");
      } catch (error) {
        throw new CliError(`cannot drive this browser tab: ${(error as Error).message}`);
      }
    }
    return (await debug.sendCommand(method, params)) as T;
  }

  private async call<T>(
    contents: WebContents,
    objectId: string,
    fn: string,
    args: unknown[] = [],
  ): Promise<T> {
    const res = await this.send<EvaluateResult>(contents, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((a) =>
        typeof a === "object" && a !== null && "objectId" in a ? a : { value: a },
      ),
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new CliError(
        `the page failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result.value as T;
  }

  /** Runs `body` with the tab's page, releasing what it took from the page after. */
  private async with<T>(
    tabId: string,
    body: (contents: WebContents, state: TabState) => Promise<T>,
  ): Promise<T> {
    const contents = this.contents(tabId);
    const done = this.driven.begin(contents);
    try {
      return await body(contents, this.state(contents));
    } finally {
      done();
      if (contents.debugger.isAttached()) {
        await this.send(contents, "Runtime.releaseObjectGroup", {
          objectGroup: OBJECT_GROUP,
        }).catch(() => {});
      }
    }
  }

  /** `with` for a command that has the page draw: a screenshot or a click. */
  private withDrawn<T>(
    tabId: string,
    body: (contents: WebContents, state: TabState) => Promise<T>,
  ): Promise<T> {
    return this.with(tabId, (contents, state) => this.parked(tabId, () => body(contents, state)));
  }

  /**
   * Runs `body` with a page that is not shown in a hidden window of its own.
   * On macOS such a page draws when it is captured. On Windows a page out of
   * the window has nothing to draw with, so a screenshot of it never came and
   * a click never landed; Linux shares Windows' window code, so it is done
   * there too. Should the tab be shown meanwhile, the app's window takes the
   * page back.
   */
  private async parked<T>(tabId: string, body: () => Promise<T>): Promise<T> {
    const page = this.pageOf(tabId);
    if (this.mac || !page || page.active) return body();
    const { view } = page;
    const bounds = view.getBounds();
    const host = new BaseWindow({
      show: false,
      width: bounds.width,
      height: bounds.height,
      skipTaskbar: true,
      focusable: false,
    });
    try {
      host.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      return await body();
    } finally {
      if (host.contentView.children.includes(view)) {
        host.contentView.removeChildView(view);
        view.setBounds(bounds);
      }
      host.destroy();
    }
  }

  /**
   * Page.captureScreenshot, which waits for the page to draw. A hidden page
   * draws only while it is captured, so off macOS one that is not shown is
   * captured meanwhile as Electron has a hidden page draw. Gives up after
   * DRAW_MS rather than wait on a page that never draws.
   */
  private async capture(tabId: string, contents: WebContents, params: object): Promise<string> {
    let drawing = !this.mac && this.pageOf(tabId)?.active === false;
    const keepDrawing = async () => {
      while (drawing && !contents.isDestroyed()) {
        const image = await contents.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty()) await delay(WAIT_POLL_MS);
      }
    };
    keepDrawing().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CliError(
              `the page did not draw in ${DRAW_MS / 1000} s; show its tab with "nexus tab show" and try again`,
            ),
          ),
        DRAW_MS,
      );
    });
    try {
      const shot = this.send<{ data: string }>(contents, "Page.captureScreenshot", params);
      return (await Promise.race([shot, timeout])).data;
    } finally {
      drawing = false;
      clearTimeout(timer);
    }
  }

  private async locate(contents: WebContents, state: TabState, target: string): Promise<Located> {
    if (/^e\d+$/.test(target)) {
      const ref = state.refs.get(target);
      if (!ref) {
        throw new CliError(
          state.refs.size === 0
            ? `no snapshot of this page yet, so no ${target}; take one with "nexus browser snapshot"`
            : `the last snapshot has no ${target}`,
        );
      }
      if (state.loads !== state.snapshotLoads) {
        throw new CliError(`the page has changed since the snapshot; take a new one for ${target}`);
      }
      const stale = new CliError(`${target} is no longer on the page; take a new snapshot`);
      let objectId: string | undefined;
      try {
        const res = await this.send<{ object: RemoteObject }>(contents, "DOM.resolveNode", {
          backendNodeId: ref.backendNodeId,
          objectGroup: OBJECT_GROUP,
        });
        objectId = res.object.objectId;
      } catch {
        throw stale;
      }
      if (
        !objectId ||
        !(await this.call<boolean>(contents, objectId, "function () { return this.isConnected; }"))
      ) {
        throw stale;
      }
      return { objectId, backendNodeId: ref.backendNodeId, label: label(ref, target) };
    }

    const res = await this.send<EvaluateResult>(contents, "Runtime.evaluate", {
      expression: `(() => { const all = document.querySelectorAll(${JSON.stringify(target)}); return all.length === 1 ? all[0] : all.length; })()`,
      objectGroup: OBJECT_GROUP,
    });
    if (res.exceptionDetails) {
      throw new CliError(`${target} is neither a ref such as e12 nor a CSS selector`, 2);
    }
    if (res.result.type === "number") {
      const count = res.result.value as number;
      throw new CliError(
        count === 0
          ? `nothing on the page matches ${target}`
          : `${count} elements match ${target}; narrow the selector, or use a ref from "nexus browser snapshot"`,
      );
    }
    const objectId = res.result.objectId as string;
    const { node } = await this.send<{ node: { backendNodeId: number } }>(
      contents,
      "DOM.describeNode",
      { objectId },
    );
    const name = await this.call<string>(contents, objectId, DESCRIBE);
    return { objectId, backendNodeId: node.backendNodeId, label: name };
  }

  /** The middle of the element on screen, scrolled into view. */
  private async point(contents: WebContents, el: Located): Promise<{ x: number; y: number }> {
    await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: el.backendNodeId,
    }).catch(() => {});
    let quads: number[][] = [];
    try {
      quads = (
        await this.send<{ quads: number[][] }>(contents, "DOM.getContentQuads", {
          backendNodeId: el.backendNodeId,
        })
      ).quads;
    } catch {
      // No layout box: hidden, or not rendered at all.
    }
    const quad = quads.find((q) => {
      const xs = [q[0], q[2], q[4], q[6]] as number[];
      const ys = [q[1], q[3], q[5], q[7]] as number[];
      return Math.max(...xs) - Math.min(...xs) >= 1 && Math.max(...ys) - Math.min(...ys) >= 1;
    });
    if (!quad) throw new CliError(`${el.label} is not visible on the page`);
    const x =
      ((quad[0] as number) + (quad[2] as number) + (quad[4] as number) + (quad[6] as number)) / 4;
    const y =
      ((quad[1] as number) + (quad[3] as number) + (quad[5] as number) + (quad[7] as number)) / 4;
    return { x, y };
  }

  /** Throws when something else, such as a dialog over it, would take a click there. */
  private async checkHit(
    contents: WebContents,
    el: Located,
    at: { x: number; y: number },
  ): Promise<void> {
    let hit: number;
    try {
      hit = (
        await this.send<{ backendNodeId: number }>(contents, "DOM.getNodeForLocation", {
          x: Math.round(at.x),
          y: Math.round(at.y),
          includeUserAgentShadowDOM: true,
        })
      ).backendNodeId;
    } catch {
      return;
    }
    if (hit === el.backendNodeId) return;
    const { object } = await this.send<{ object: RemoteObject }>(contents, "DOM.resolveNode", {
      backendNodeId: hit,
      objectGroup: OBJECT_GROUP,
    });
    if (!object.objectId) return;
    if (await this.call<boolean>(contents, el.objectId, CONTAINS, [{ objectId: object.objectId }]))
      return;
    const cover = await this.call<string>(contents, object.objectId, DESCRIBE);
    throw new CliError(`${el.label} is covered by ${cover}; close what covers it, or pass --force`);
  }

  /** After an action: waits for a page it started, and says where the tab is. */
  /** Where the page is before an action, for `after` to tell what the action did. */
  private mark(contents: WebContents): PageMark {
    return { url: contents.getURL(), navigations: this.navigations.get(contents) ?? 0 };
  }

  private async after(
    contents: WebContents,
    text: string,
    before: PageMark,
  ): Promise<ActionResult> {
    await this.settleOn(contents);
    // A navigation the action started may download a file instead of loading a page.
    const started = (this.navigations.get(contents) ?? 0) !== before.navigations;
    if (started) await this.awaitDownload(contents);
    const url = contents.getURL();
    const navigated = url !== before.url;
    const download = started ? this.downloads.get(contents) : undefined;
    const lines = [text];
    if (navigated) lines.push(`Now at ${url}`);
    if (download) {
      lines.push(`Downloading ${download.url} (${download.type}) to ${download.file}.`);
    }
    return {
      text: lines.join("\n"),
      url,
      title: contents.getTitle(),
      navigated,
      ...(download ? { download } : {}),
    };
  }

  /**
   * Waits a moment for the download a navigation that showed no page may
   * start, which Chromium does only after the load has stopped.
   */
  private async awaitDownload(contents: WebContents): Promise<void> {
    const until = Date.now() + DOWNLOAD_START_MS;
    while (
      this.uncommitted.has(contents) &&
      !this.downloads.has(contents) &&
      !contents.isDestroyed() &&
      Date.now() < until
    ) {
      await delay(DOWNLOAD_POLL_MS);
    }
  }

  private async settleOn(contents: WebContents): Promise<void> {
    if (!contents.isLoading()) await once(contents, "did-start-loading", NAVIGATION_START_MS);
    if (contents.isLoading()) await once(contents, "did-stop-loading", LOAD_MS);
  }

  async settle(tabId: string): Promise<PageInfo | null> {
    const deadline = Date.now() + PAGE_START_MS;
    let page = this.pageOf(tabId);
    while (!page && Date.now() < deadline) {
      await delay(WAIT_POLL_MS);
      page = this.pageOf(tabId);
    }
    if (!page || page.contents.isDestroyed()) return null;
    const contents = page.contents;
    const done = this.driven.begin(contents);
    try {
      await this.settleOn(contents);
      await this.awaitDownload(contents);
    } finally {
      done();
    }
    if (contents.isDestroyed()) return null;
    const download = this.downloads.get(contents);
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      ...(download ? { download } : {}),
    };
  }

  snapshot(tabId: string, options: { maxLines: number; within?: string }): Promise<PageSnapshot> {
    return this.with(tabId, async (contents, state) => {
      if (contents.isLoading()) await once(contents, "did-stop-loading", LOAD_MS);
      const within =
        options.within === undefined
          ? undefined
          : (await this.locate(contents, state, options.within)).backendNodeId;
      const { nodes } = await this.send<{ nodes: AxNode[] }>(
        contents,
        "Accessibility.getFullAXTree",
      );
      const snapshot = buildSnapshot(nodes, {
        maxLines: options.maxLines,
        ...(within === undefined ? {} : { within }),
      });
      state.refs = snapshot.refs;
      state.snapshotLoads = state.loads;
      return {
        url: contents.getURL(),
        title: contents.getTitle(),
        text: snapshot.text,
        omitted: snapshot.omitted,
      };
    });
  }

  /**
   * Has a hidden page draw once. Chromium routes a mouse event by what the
   * page last drew, so a page that never drew, or drew before its last load,
   * would not get it.
   */
  private async paint(tabId: string, contents: WebContents): Promise<void> {
    if (this.pageOf(tabId)?.active) return;
    await this.capture(tabId, contents, {
      format: "jpeg",
      quality: 1,
      clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    });
  }

  click(
    tabId: string,
    target: string,
    options: { double: boolean; force: boolean },
  ): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.withDrawn(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      const at = await this.point(contents, el);
      await this.paint(tabId, contents);
      if (!options.force) await this.checkHit(contents, el, at);
      const before = this.mark(contents);
      const mouse = (type: string, clickCount: number) =>
        this.send(contents, "Input.dispatchMouseEvent", {
          type,
          x: at.x,
          y: at.y,
          button: type === "mouseMoved" ? "none" : "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });
      await mouse("mouseMoved", 0);
      for (let count = 1; count <= (options.double ? 2 : 1); count++) {
        await mouse("mousePressed", count);
        await mouse("mouseReleased", count);
      }
      return this.after(
        contents,
        `${options.double ? "Double-clicked" : "Clicked"} ${el.label}.`,
        before,
      );
    });
  }

  hover(tabId: string, target: string, options: { force: boolean }): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.withDrawn(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      const at = await this.point(contents, el);
      await this.paint(tabId, contents);
      if (!options.force) await this.checkHit(contents, el, at);
      const before = this.mark(contents);
      await this.send(contents, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: at.x,
        y: at.y,
        button: "none",
      });
      return this.after(contents, `Hovered over ${el.label}.`, before);
    });
  }

  drag(tabId: string, from: string, to: string): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.withDrawn(tabId, async (contents, state) => {
      const source = await this.locate(contents, state, from);
      await this.paint(tabId, contents);
      const start = await this.pointerOn(contents, source);
      await this.checkHit(contents, source, start);
      const before = this.mark(contents);
      const mouse = (type: string, at: { x: number; y: number }) =>
        this.send(contents, "Input.dispatchMouseEvent", {
          type,
          x: at.x,
          y: at.y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      await mouse("mousePressed", start);
      // An HTML drag would go to the system, which no input here reaches:
      // Chromium hands it back instead, to be dropped with drag events.
      await this.send(contents, "Input.setInterceptDrags", { enabled: true });
      let data: unknown;
      try {
        const intercepted = this.next(contents, "Input.dragIntercepted", DRAG_INTERCEPT_MS);
        await mouse("mouseMoved", { x: start.x + DRAG_START_PX, y: start.y + DRAG_START_PX });
        data = ((await intercepted) as { data?: unknown } | null)?.data;
      } finally {
        await this.send(contents, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
      }
      // The target is looked for once the drag has begun, as a page may move things then.
      const target = await this.locate(contents, state, to);
      const end = await this.point(contents, target);
      if (data !== undefined) {
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await this.send(contents, "Input.dispatchDragEvent", {
            type,
            x: end.x,
            y: end.y,
            data,
            modifiers: 0,
          });
        }
      } else {
        for (let step = 1; step <= DRAG_STEPS; step++) {
          await mouse("mouseMoved", {
            x: start.x + ((end.x - start.x) * step) / DRAG_STEPS,
            y: start.y + ((end.y - start.y) * step) / DRAG_STEPS,
          });
        }
        await mouse("mouseReleased", end);
      }
      return this.after(contents, `Dragged ${source.label} onto ${target.label}.`, before);
    });
  }

  scroll(tabId: string, scroll: BrowserScroll, within?: string): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.with(tabId, async (contents, state) => {
      const before = this.mark(contents);
      if (scroll.kind === "to") {
        const el = await this.locate(contents, state, scroll.target);
        await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
          backendNodeId: el.backendNodeId,
        });
        return this.after(contents, `Scrolled ${el.label} into view.`, before);
      }
      const box =
        within === undefined
          ? { objectId: await this.documentObject(contents), label: "the page" }
          : await this.locate(contents, state, within);
      const how = scroll.kind === "end" ? { end: scroll.end } : scroll;
      const done = await this.call<Scrolled>(contents, box.objectId, SCROLL, [how]);
      return this.after(contents, scrolledText(box.label, scroll, done), before);
    });
  }

  /**
   * Moves the mouse onto the element and says where it is then. Moving may
   * change the page, as a menu the mouse leaves closes, so the element is
   * looked for again once the mouse is there.
   */
  private async pointerOn(contents: WebContents, el: Located): Promise<{ x: number; y: number }> {
    let at = await this.point(contents, el);
    for (let tries = 0; tries < 3; tries++) {
      await this.send(contents, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...at,
        button: "none",
      });
      const now = await this.point(contents, el);
      if (Math.abs(now.x - at.x) < 1 && Math.abs(now.y - at.y) < 1) return now;
      at = now;
    }
    return at;
  }

  /** The page's document, as an object to call a function on. */
  private async documentObject(contents: WebContents): Promise<string> {
    const res = await this.send<EvaluateResult>(contents, "Runtime.evaluate", {
      expression: "document",
      objectGroup: OBJECT_GROUP,
    });
    const objectId = res.result.objectId;
    if (!objectId) throw new CliError("the page has no document");
    return objectId;
  }

  /** The next event `method` of the tab's protocol connection; null if none comes in `ms`. */
  private next(contents: WebContents, method: string, ms: number): Promise<unknown> {
    const debug = contents.debugger;
    return new Promise((resolve) => {
      const onMessage = (_event: unknown, name: string, params: unknown) => {
        if (name !== method) return;
        clearTimeout(timer);
        debug.removeListener("message", onMessage);
        resolve(params);
      };
      const timer = setTimeout(() => {
        debug.removeListener("message", onMessage);
        resolve(null);
      }, ms);
      debug.on("message", onMessage);
    });
  }

  fill(tabId: string, target: string, text: string): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.with(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: el.backendNodeId,
      }).catch(() => {});
      const before = this.mark(contents);
      const ready = await this.call<{ kind?: "set" | "text"; value?: string; error?: string }>(
        contents,
        el.objectId,
        PREPARE_FILL,
        [text],
      );
      if (ready.error) throw new CliError(`cannot fill ${el.label}: ${ready.error}`);
      if (ready.kind === "text") {
        if (text === "") await this.pressKey(contents, parseBrowserKey("Delete", this.mac));
        else await this.send(contents, "Input.insertText", { text });
      }
      const shown = ready.kind === "set" ? (ready.value ?? text) : text;
      return this.after(contents, `Filled ${el.label} with ${JSON.stringify(shown)}.`, before);
    });
  }

  type(tabId: string, text: string, target?: string): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.with(tabId, async (contents, state) => {
      let into = "";
      if (target !== undefined) {
        const el = await this.locate(contents, state, target);
        await this.send(contents, "DOM.focus", { backendNodeId: el.backendNodeId }).catch(() => {
          throw new CliError(`${el.label} cannot take focus`);
        });
        into = ` into ${el.label}`;
      }
      const before = this.mark(contents);
      await this.send(contents, "Input.insertText", { text });
      return this.after(contents, `Typed ${JSON.stringify(text)}${into}.`, before);
    });
  }

  press(tabId: string, keys: readonly string[]): Promise<ActionResult> {
    // Read every key before pressing any, so a typo presses nothing.
    const presses = keys.map((k) => parseBrowserKey(k, this.mac));
    this.notPicking(tabId);
    return this.with(tabId, async (contents) => {
      const before = this.mark(contents);
      for (const press of presses) await this.pressKey(contents, press);
      return this.after(contents, `Pressed ${keys.join(" ")}.`, before);
    });
  }

  private async pressKey(contents: WebContents, press: KeyPress): Promise<void> {
    const common = {
      key: press.key,
      code: press.code,
      windowsVirtualKeyCode: press.keyCode,
      nativeVirtualKeyCode: press.keyCode,
      modifiers: press.modifiers,
    };
    await this.send(contents, "Input.dispatchKeyEvent", {
      ...common,
      type: press.text === undefined ? "rawKeyDown" : "keyDown",
      ...(press.text === undefined ? {} : { text: press.text, unmodifiedText: press.text }),
      ...(press.commands ? { commands: press.commands } : {}),
    });
    await this.send(contents, "Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }

  screenshot(tabId: string, options: { full: boolean; element?: string }): Promise<string> {
    return this.withDrawn(tabId, async (contents, state) => {
      if (options.element !== undefined) {
        const el = await this.locate(contents, state, options.element);
        await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
          backendNodeId: el.backendNodeId,
        }).catch(() => {});
        const box = await this.call<Box | null>(contents, el.objectId, ELEMENT_CLIP);
        if (box === null) throw new CliError(`${el.label} is not visible on the page`);
        const clip = {
          ...box,
          height: Math.min(box.height, MAX_FULL_HEIGHT),
          scale: 1,
        };
        return this.capture(tabId, contents, { format: "png", captureBeyondViewport: true, clip });
      }
      if (!options.full) return this.capture(tabId, contents, { format: "png" });
      const metrics = await this.send<{
        cssContentSize?: { width: number; height: number };
        contentSize: { width: number; height: number };
      }>(contents, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.min(Math.ceil(size.height), MAX_FULL_HEIGHT),
        scale: 1,
      };
      return this.capture(tabId, contents, { format: "png", captureBeyondViewport: true, clip });
    });
  }

  inspect(tabId: string, target: string): Promise<PickedElement> {
    return this.withDrawn(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: el.backendNodeId,
      }).catch(() => {});
      return this.describePicked(tabId, contents, state, el.backendNodeId);
    });
  }

  evaluate(tabId: string, expression: string): Promise<unknown> {
    return this.with(tabId, async (contents) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CliError(`the script did not finish in ${EVALUATE_MS / 1000} s`)),
          EVALUATE_MS,
        );
      });
      try {
        const res = await Promise.race([
          this.send<EvaluateResult>(contents, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
            replMode: true,
          }),
          timeout,
        ]);
        if (res.exceptionDetails) {
          const details = res.exceptionDetails;
          throw new CliError(`the page threw: ${details.exception?.description ?? details.text}`);
        }
        const { result } = res;
        if (result.unserializableValue !== undefined) return result.unserializableValue;
        return result.value;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  console(tabId: string, clear: boolean): readonly ConsoleEntry[] {
    this.contents(tabId);
    return this.consoles.get(tabId)?.log.read(clear) ?? [];
  }

  async waitFor(
    tabId: string,
    condition: BrowserWaitCondition,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const contents = this.contents(tabId);
      if (await this.holds(contents, condition)) return true;
      if (Date.now() >= deadline) return false;
      await delay(WAIT_POLL_MS);
    }
  }

  private async holds(contents: WebContents, condition: BrowserWaitCondition): Promise<boolean> {
    switch (condition.kind) {
      case "load":
        return !contents.isLoading();
      case "url":
        return condition.pattern.test(contents.getURL());
      case "text":
      case "selector": {
        const expression =
          condition.kind === "text"
            ? `(document.body?.innerText ?? "").includes(${JSON.stringify(condition.text)})`
            : `(() => { const el = document.querySelector(${JSON.stringify(condition.selector)}); return !!el && (el.checkVisibility ? el.checkVisibility() : true); })()`;
        let found: boolean;
        try {
          const res = await this.send<EvaluateResult>(contents, "Runtime.evaluate", {
            expression,
            returnByValue: true,
          });
          if (res.exceptionDetails) {
            if (condition.kind === "selector")
              throw new CliError(`${condition.selector} is not a CSS selector`, 2);
            return false;
          }
          found = res.result.value === true;
        } catch (error) {
          if (error instanceof CliError) throw error;
          // The page is between loads.
          return false;
        }
        return found !== condition.gone;
      }
    }
  }

  /** Ends the pick going on in a tab, if there is one. */
  cancelPick(tabId: string): void {
    this.picking.get(tabId)?.end("aborted");
  }

  pick(tabId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PickResult> {
    // The tab is taken before anything is awaited, so another pick, the
    // signal or the timeout reach this one from its start, and an earlier
    // pick, ended here, leaves the page's inspect mode to this one.
    const control = new PickControl();
    this.picking.get(tabId)?.end("replaced");
    this.picking.set(tabId, control);
    const timer = setTimeout(() => control.end("timeout"), options.timeoutMs);
    const onAbort = () => control.end("aborted");
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) control.end("aborted");
    return this.with(tabId, async (contents, state) => {
      const unwatch = this.watchPick(contents, control);
      try {
        const ready = this.pickable(tabId, contents, control);
        ready.catch(() => {});
        await Promise.race([ready, control.ended]);
        if (control.reason !== null) return { cancelled: control.reason };
        const outcome = await this.inspectMode(tabId, contents, control);
        if ("cancelled" in outcome) return outcome;
        return { picked: await this.describePicked(tabId, contents, state, outcome.backendNodeId) };
      } finally {
        unwatch();
      }
    }).finally(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (this.picking.get(tabId) !== control) return;
      this.picking.delete(tabId);
      // In case the pick ended before inspect: an earlier pick it replaced
      // left the page in inspect mode to it.
      const page = this.pageOf(tabId);
      if (page) endInspect(page.contents);
    });
  }

  /** Refuses page input to a tab whose page waits for the user's pick. */
  private notPicking(tabId: string): void {
    if (this.picking.has(tabId)) {
      throw new CliError(
        "the user is picking an element in this browser tab; try again once the pick ends",
      );
    }
  }

  /** Waits until the tab is shown and its page has loaded, as a pick needs. */
  private async pickable(tabId: string, contents: WebContents, control: PickControl): Promise<void> {
    const deadline = Date.now() + SHOW_MS;
    while (!this.pageOf(tabId)?.active) {
      if (control.reason !== null) return;
      if (Date.now() >= deadline) {
        throw new CliError('the browser tab is not shown; show it with "nexus tab show"');
      }
      await delay(WAIT_POLL_MS);
    }
    if (contents.isLoading()) await once(contents, "did-stop-loading", LOAD_MS);
  }

  /**
   * Ends the pick on Esc, which is kept from the page, and when the page
   * goes to another or the tab closes. Returns what stops watching.
   */
  private watchPick(contents: WebContents, control: PickControl): () => void {
    const debug = contents.debugger;
    const onInput = (event: { preventDefault(): void }, input: Input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        control.end("escape");
      }
    };
    const onMessage = (_event: unknown, method: string) => {
      if (method === "Overlay.inspectModeCanceled") control.end("escape");
    };
    const onNavigate = () => control.end("navigated");
    const onClosed = () => control.end("closed");
    contents.on("before-input-event", onInput);
    contents.on("did-navigate", onNavigate);
    contents.once("destroyed", onClosed);
    debug.on("message", onMessage);
    debug.on("detach", onClosed);
    return () => {
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("did-navigate", onNavigate);
      contents.removeListener("destroyed", onClosed);
      debug.removeListener("message", onMessage);
      debug.removeListener("detach", onClosed);
    };
  }

  /**
   * Puts the page in DevTools' inspect mode until the user clicks an element
   * or the pick ends, then takes the page out of it, unless a later pick has
   * the tab by then.
   */
  private async inspectMode(
    tabId: string,
    contents: WebContents,
    control: PickControl,
  ): Promise<{ backendNodeId: number } | { cancelled: PickCancel }> {
    // The Overlay domain works only with the DOM domain on; both stay on.
    await this.send(contents, "DOM.enable");
    await this.send(contents, "Overlay.enable");
    if (control.reason !== null) return { cancelled: control.reason };
    const debug = contents.debugger;
    return new Promise((resolve, reject) => {
      let done = false;
      /** Undoes what inspect set up; false when that is done already. */
      const stop = (): boolean => {
        if (done) return false;
        done = true;
        clearInterval(watch);
        debug.removeListener("message", onMessage);
        if (this.picking.get(tabId) === control) endInspect(contents);
        return true;
      };
      const onMessage = (_event: unknown, method: string, params: { backendNodeId?: number }) => {
        if (method === "Overlay.inspectNodeRequested" && params.backendNodeId !== undefined) {
          if (stop()) resolve({ backendNodeId: params.backendNodeId });
        }
      };
      const watch = setInterval(() => {
        if (!this.pageOf(tabId)?.active) control.end("hidden");
      }, WAIT_POLL_MS);
      debug.on("message", onMessage);
      void control.ended.then((reason) => {
        if (stop()) resolve({ cancelled: reason });
      });
      this.send(contents, "Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: PICK_HIGHLIGHT,
      }).then(
        () => {
          if (done) return;
          contents.focus();
          this.hoverAtCursor(tabId, contents);
        },
        (error: unknown) => {
          if (stop()) reject(error);
        },
      );
    });
  }

  /**
   * Tells inspect mode where the mouse already is. It picks what the mouse
   * last moved over, so a click before any move would reach the page.
   */
  private hoverAtCursor(tabId: string, contents: WebContents): void {
    const page = this.pageOf(tabId);
    if (!page) return;
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.includes(page.view));
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const content = win.getContentBounds();
    const bounds = page.view.getBounds();
    const x = cursor.x - content.x - bounds.x;
    const y = cursor.y - content.y - bounds.y;
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;
    this.send(contents, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }).catch(() => {});
  }

  /** What the picked element is, with a ref to it and a picture of it. */
  private async describePicked(
    tabId: string,
    contents: WebContents,
    state: TabState,
    backendNodeId: number,
  ): Promise<PickedElement> {
    const { object } = await this.send<{ object: RemoteObject }>(contents, "DOM.resolveNode", {
      backendNodeId,
      objectGroup: OBJECT_GROUP,
    });
    if (!object.objectId) throw new CliError("the picked element is gone from the page");
    const details = await this.call<PickedDetails>(contents, object.objectId, DESCRIBE_PICKED);
    let role = "";
    let name = "";
    try {
      const { nodes } = await this.send<{ nodes: AxNode[] }>(
        contents,
        "Accessibility.getPartialAXTree",
        { backendNodeId, fetchRelatives: false },
      );
      const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
      if (node) ({ role, name } = roleAndName(node));
    } catch {
      // No accessibility node; its tag names it.
    }
    const ref = remember(state, { backendNodeId, role, name });
    const png =
      details.clip === null
        ? undefined
        : await this.capture(tabId, contents, {
            format: "png",
            clip: { ...details.clip, scale: 1 },
          }).catch(() => undefined);
    // Whatever the page wrote may reach a terminal.
    return cleanPicked({
      url: contents.getURL(),
      title: contents.getTitle(),
      role,
      name,
      ref,
      ...details,
      ...(png === undefined ? {} : { png }),
    });
  }
}

/** One pick: what ended it, and a promise that settles when something does. */
class PickControl {
  reason: PickCancel | null = null;
  readonly ended: Promise<PickCancel>;
  private settle: (reason: PickCancel) => void = () => {};

  constructor() {
    this.ended = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  readonly end = (reason: PickCancel): void => {
    if (this.reason !== null) return;
    this.reason = reason;
    this.settle(reason);
  };
}

/**
 * Takes the page out of inspect mode. Chromium refuses "none" without a
 * highlight config, leaving the page in inspect mode, where this session's
 * own clicks go nowhere.
 */
function endInspect(contents: WebContents): void {
  const debug = contents.debugger;
  if (contents.isDestroyed() || !debug.isAttached()) return;
  debug.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => {});
  debug.sendCommand("Overlay.hideHighlight").catch(() => {});
}

/**
 * A ref for `element`, so browser click and the like take it: the one the
 * last snapshot gave it, or the next number. A snapshot of an earlier page
 * is dropped first, as its refs no longer work.
 */
function remember(state: TabState, element: SnapshotRef): string {
  if (state.loads !== state.snapshotLoads) {
    state.refs = new Map();
    state.snapshotLoads = state.loads;
  }
  for (const [ref, known] of state.refs) {
    if (known.backendNodeId === element.backendNodeId) return ref;
  }
  const ref = `e${state.refs.size + 1}`;
  state.refs = new Map(state.refs).set(ref, element);
  return ref;
}

/** What a scroll did, said for people: how far it went and where it is now. */
function scrolledText(
  what: string,
  scroll: Exclude<BrowserScroll, { kind: "to" }>,
  done: Scrolled,
): string {
  const across = scroll.kind === "by" && (scroll.way === "left" || scroll.way === "right");
  const max = Math.max(0, Math.round(across ? done.max.x : done.max.y));
  // A page zoomed or scaled scrolls by fractions, which may round past the end.
  const at = Math.min(max, Math.round(across ? done.at.x : done.at.y));
  const moved = Math.abs(across ? done.moved.x : done.moved.y);
  const where = `${what} is at ${at} of ${max}px`;
  if (moved < 1) {
    return max < 1 ? `${capital(what)} does not scroll that way.` : `Already there; ${where}.`;
  }
  const how =
    scroll.kind === "by" ? `${scroll.way} ${Math.round(moved)}px` : `to the ${scroll.end}`;
  return `Scrolled ${how}; ${where}.`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
