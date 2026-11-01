/**
 * Drives the app's browser tabs for nexus browser snapshot, click, fill,
 * type, press, screenshot, eval, console and wait, through each tab's own
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
import { BaseWindow, type View, type WebContents } from "electron";
import { CliError } from "../context";
import { type ConsoleEntry, type ConsoleLog, watchConsole } from "./console-log";
import { type KeyPress, parseBrowserKey } from "./keys";
import { type AxNode, buildSnapshot, type SnapshotRef } from "./snapshot";

export interface PageInfo {
  readonly url: string;
  readonly title: string;
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
  fill(tabId: string, target: string, text: string): Promise<ActionResult>;
  type(tabId: string, text: string, target?: string): Promise<ActionResult>;
  press(tabId: string, keys: readonly string[]): Promise<ActionResult>;
  /** A PNG, base64. */
  screenshot(tabId: string, options: { full: boolean }): Promise<string>;
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
/**
 * The size a tab never shown gets, so its page lays out and takes clicks.
 * The app gives it its real size once it is shown.
 */
const HIDDEN_SIZE = { width: 1280, height: 800 };
/** The tallest a --full screenshot is taken, in CSS pixels. */
const MAX_FULL_HEIGHT = 16_384;

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

  constructor(
    private readonly pageOf: (tabId: string) => BrowserPage | undefined,
    private readonly mac = process.platform === "darwin",
  ) {}

  /** Starts keeping `tabId`'s console; called as each browser tab is created. */
  watch(tabId: string, contents: WebContents): void {
    this.consoles.set(tabId, { contents, log: watchConsole(contents) });
    contents.once("destroyed", () => {
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
    try {
      return await body(contents, this.state(contents));
    } finally {
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
  private async after(contents: WebContents, text: string, before: string): Promise<ActionResult> {
    await this.settleOn(contents);
    const url = contents.getURL();
    const navigated = url !== before;
    return {
      text: navigated ? `${text}\nNow at ${url}` : text,
      url,
      title: contents.getTitle(),
      navigated,
    };
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
    await this.settleOn(contents);
    return { url: contents.getURL(), title: contents.getTitle() };
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
    return this.withDrawn(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      const at = await this.point(contents, el);
      await this.paint(tabId, contents);
      if (!options.force) await this.checkHit(contents, el, at);
      const before = contents.getURL();
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

  fill(tabId: string, target: string, text: string): Promise<ActionResult> {
    return this.with(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      await this.send(contents, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: el.backendNodeId,
      }).catch(() => {});
      const before = contents.getURL();
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
    return this.with(tabId, async (contents, state) => {
      let into = "";
      if (target !== undefined) {
        const el = await this.locate(contents, state, target);
        await this.send(contents, "DOM.focus", { backendNodeId: el.backendNodeId }).catch(() => {
          throw new CliError(`${el.label} cannot take focus`);
        });
        into = ` into ${el.label}`;
      }
      const before = contents.getURL();
      await this.send(contents, "Input.insertText", { text });
      return this.after(contents, `Typed ${JSON.stringify(text)}${into}.`, before);
    });
  }

  press(tabId: string, keys: readonly string[]): Promise<ActionResult> {
    // Read every key before pressing any, so a typo presses nothing.
    const presses = keys.map((k) => parseBrowserKey(k, this.mac));
    return this.with(tabId, async (contents) => {
      const before = contents.getURL();
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

  screenshot(tabId: string, options: { full: boolean }): Promise<string> {
    return this.withDrawn(tabId, async (contents) => {
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
}
