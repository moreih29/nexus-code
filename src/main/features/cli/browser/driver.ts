import { stat } from "node:fs/promises";
import path from "node:path";
import {
  BaseWindow,
  type Input,
  type Rectangle,
  screen,
  type View,
  type WebContents,
} from "electron";
import { firstMatch } from "../../../infra/security/bounded-match";
import type { BrowserHostWindow } from "../../browser/registry";
import { CliError } from "../context";
import { DESCRIBE_COMPONENT, type PickedComponent } from "./component";
import { type ConsoleEntry, type ConsoleLog, watchConsole } from "./console-log";
import { dialogText, type PageDialog } from "./dialog";
import { DrivenTabs, saveCommandDownload } from "./downloads";
import { type KeyPress, parseBrowserKey } from "./keys";
import { type NetworkEntry, NetworkLog } from "./network-log";
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
  readonly download?: PageDownload;
}

export interface PageDownload {
  readonly url: string;
  readonly file: string;
  readonly type: string;
}

export interface PageSnapshot extends PageInfo {
  readonly text: string;
  readonly omitted: number;
}

export type { PageDialog } from "./dialog";

export interface RequestDetails {
  readonly entry: NetworkEntry;
  readonly postData?: string;
  readonly body: ResponseBody;
}

export type ResponseBody =
  | { readonly kind: "text"; readonly text: string; readonly length: number }
  | { readonly kind: "binary"; readonly bytes: number }
  | { readonly kind: "none"; readonly why: string };

export interface ActionResult extends PageInfo {
  readonly text: string;
  readonly navigated: boolean;
}

interface PageMark {
  readonly url: string;
  readonly navigations: number;
}

export type BrowserScroll =
  | {
      readonly kind: "by";
      readonly way: "up" | "down" | "left" | "right";
      readonly amount?: number;
    }
  | { readonly kind: "end"; readonly end: "top" | "bottom" }
  | { readonly kind: "to"; readonly target: string };

export type BrowserWaitCondition =
  | { readonly kind: "load" }
  | { readonly kind: "text"; readonly text: string; readonly gone: boolean }
  | { readonly kind: "selector"; readonly selector: string; readonly gone: boolean }
  | { readonly kind: "url"; readonly pattern: RegExp };

export interface BrowserPage {
  readonly contents: WebContents;
  readonly view: View;
  readonly host: BrowserHostWindow;
  readonly active: boolean;
  readonly loadFailure?: { url: string; description: string } | null;
}

export interface BrowserViewState {
  readonly visible: boolean;
  readonly bounds: Rectangle | null;
}

export interface BrowserDriver {
  viewState(tabId: string): BrowserViewState;
  snapshot(tabId: string, options: { maxLines: number; within?: string }): Promise<PageSnapshot>;
  click(
    tabId: string,
    target: string,
    options: { double: boolean; force: boolean },
  ): Promise<ActionResult>;
  hover(tabId: string, target: string, options: { force: boolean }): Promise<ActionResult>;
  drag(tabId: string, from: string, to: string): Promise<ActionResult>;
  scroll(tabId: string, scroll: BrowserScroll, within?: string): Promise<ActionResult>;
  fill(tabId: string, target: string, text: string): Promise<ActionResult>;
  type(tabId: string, text: string, target?: string): Promise<ActionResult>;
  press(tabId: string, keys: readonly string[]): Promise<ActionResult>;
  upload(tabId: string, target: string, files: readonly string[]): Promise<ActionResult>;
  dialog(tabId: string): Promise<PageDialog | null>;
  answerDialog(tabId: string, accept: boolean): Promise<ActionResult>;
  screenshot(tabId: string, options: { full: boolean; element?: string }): Promise<string>;
  inspect(tabId: string, target: string): Promise<PickedElement>;
  evaluate(tabId: string, expression: string): Promise<unknown>;
  console(tabId: string, clear: boolean): readonly ConsoleEntry[];
  network(tabId: string, clear: boolean): readonly NetworkEntry[];
  request(tabId: string, id: number, maxBody: number): Promise<RequestDetails>;
  waitFor(tabId: string, condition: BrowserWaitCondition, timeoutMs: number): Promise<boolean>;
  settle(tabId: string): Promise<PageInfo | null>;
  pick(tabId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PickResult>;
}

const OBJECT_GROUP = "nexus-cli";
const NAVIGATION_START_MS = 300;
const LOAD_MS = 15_000;
const EVALUATE_MS = 60_000;
const DRAW_MS = 30_000;
const WAIT_POLL_MS = 250;
const PAGE_START_MS = 3_000;
const DOWNLOAD_START_MS = 1_000;
const DOWNLOAD_POLL_MS = 50;
const HIDDEN_SIZE = { width: 1280, height: 800 };
const MAX_FULL_HEIGHT = 16_384;
const SHOW_MS = 3_000;
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
  loads: number;
  snapshotLoads: number;
}

interface Located {
  readonly objectId: string;
  readonly backendNodeId: number;
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

const CONTAINS = `function (hit) {
  for (let node = hit; node; node = node.parentNode || node.host) if (node === this) return true;
  return false;
}`;

const DESCRIBE = `function () {
  if (this.nodeType !== 1) return this.nodeName.toLowerCase();
  const id = this.id ? "#" + this.id : "";
  const cls = typeof this.className === "string" && this.className.trim()
    ? "." + this.className.trim().split(/\\s+/).slice(0, 3).join(".")
    : "";
  return "<" + this.localName + id + cls + ">";
}`;

const FILE_INPUT = `function () {
  return { file: this instanceof HTMLInputElement && this.type === "file", multiple: !!this.multiple };
}`;

const CLEAR_FILES = `function () {
  if (this.files.length === 0) return;
  this.value = "";
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const ELEMENT_CLIP = `function () {
  const r = this.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
}`;

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

interface Scrolled {
  readonly moved: { readonly x: number; readonly y: number };
  readonly at: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

const NETWORK_BUFFERS = { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 };

function looksLikeText(bytes: Buffer): boolean {
  const head = bytes.length > 4096 ? bytes.subarray(0, 4093) : bytes;
  if (head.includes(0)) return false;
  return !head.toString("utf8").includes("\uFFFD");
}

const ATTACH_ANSWER_MS = 2_000;

const DRAG_START_PX = 8;
const DRAG_INTERCEPT_MS = 250;
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

class DialogShown extends CliError {
  constructor(dialog: PageDialog) {
    super(dialogText(dialog));
  }
}

export class CdpBrowserDriver implements BrowserDriver {
  private readonly states = new WeakMap<WebContents, TabState>();
  private readonly consoles = new Map<string, { contents: WebContents; log: ConsoleLog }>();
  private readonly picking = new Map<string, PickControl>();
  private readonly downloads = new WeakMap<WebContents, PageDownload>();
  private readonly uncommitted = new WeakSet<WebContents>();
  private readonly driven = new DrivenTabs<WebContents>();
  private readonly navigations = new WeakMap<WebContents, number>();
  private readonly dialogs = new WeakMap<WebContents, PageDialog>();
  private readonly opened = new WeakMap<WebContents, Set<() => void>>();
  private readonly unanswered = new WeakSet<WebContents>();
  private readonly enabling = new WeakMap<WebContents, Promise<unknown>>();
  private readonly networks = new WeakMap<WebContents, NetworkLog>();
  private readonly choosers = new WeakMap<WebContents, number>();
  private readonly watched = new WeakSet<WebContents>();
  private readonly downloadSessions = new WeakSet<Electron.Session>();

  constructor(
    private readonly pageOf: (tabId: string) => BrowserPage | undefined,
    private readonly mac = process.platform === "darwin",
  ) {}

  viewState(tabId: string): BrowserViewState {
    const page = this.pageOf(tabId);
    if (!page || page.contents.isDestroyed() || page.host.isDestroyed()) {
      return { visible: false, bounds: null };
    }
    const { active, host, view } = page;
    const bounds = view.getBounds();
    return {
      visible:
        active &&
        host.isVisible() &&
        !host.isMinimized() &&
        host.contentView.children.includes(view) &&
        view.getVisible() &&
        bounds.width > 0 &&
        bounds.height > 0,
      bounds,
    };
  }

  watch(tabId: string, contents: WebContents): void {
    this.consoles.set(tabId, { contents, log: watchConsole(contents) });
    this.networks.set(contents, new NetworkLog());
    try {
      this.attachNow(contents);
    } catch {}
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.downloads.delete(contents);
      this.uncommitted.add(contents);
      this.navigations.set(contents, (this.navigations.get(contents) ?? 0) + 1);
    });
    contents.on("did-navigate", () => this.uncommitted.delete(contents));
    this.watched.add(contents);
    const session = contents.session;
    if (!this.downloadSessions.has(session)) {
      this.downloadSessions.add(session);
      session.on("will-download", (_event, item, from) => this.noteDownload(item, from));
    }
    contents.once("destroyed", () => {
      this.watched.delete(contents);
      if (this.consoles.get(tabId)?.contents === contents) this.consoles.delete(tabId);
    });
  }

  private noteDownload(item: Electron.DownloadItem, from: WebContents | undefined): void {
    if (!from || !this.watched.has(from)) return;
    const file = this.driven.drives(from) ? saveCommandDownload(item) : item.getFilename();
    this.downloads.set(from, { url: item.getURL(), file, type: item.getMimeType() });
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
    await this.attach(contents);
    if (method !== "Page.handleJavaScriptDialog") this.noDialog(contents);
    const work = contents.debugger.sendCommand(method, params);
    const settled = await this.unlessOpened(contents, work);
    if ("done" in settled) return settled.done as T;
    const dialog = this.dialogs.get(contents);
    if (!dialog) return (await work) as T;
    throw new DialogShown(dialog);
  }

  private async attach(contents: WebContents): Promise<void> {
    this.attachNow(contents);
    const enabling = this.enabling.get(contents);
    if (enabling && this.unanswered.has(contents)) {
      await Promise.race([enabling, delay(ATTACH_ANSWER_MS)]);
    }
    if (this.unanswered.has(contents)) {
      throw new CliError(
        "the page does not answer: it may show a dialog it opened before it was driven, which only the app can answer; answer it there and try again",
      );
    }
  }

  private attachNow(contents: WebContents): void {
    const debug = contents.debugger;
    if (debug.isAttached()) return;
    try {
      debug.attach("1.3");
    } catch (error) {
      throw new CliError(`cannot drive this browser tab: ${(error as Error).message}`);
    }
    if (!this.networks.has(contents)) this.networks.set(contents, new NetworkLog());
    this.listen(contents);
    this.unanswered.add(contents);
    const enabling = debug.sendCommand("Page.enable").then(
      () => this.unanswered.delete(contents),
      () => this.unanswered.delete(contents),
    );
    this.enabling.set(contents, enabling);
    debug.sendCommand("Network.enable", NETWORK_BUFFERS).catch(() => {});
  }

  private listen(contents: WebContents): void {
    const debug = contents.debugger;
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === "Page.javascriptDialogOpening") {
        this.dialogs.set(contents, {
          type: String(params.type),
          message: String(params.message ?? ""),
          url: String(params.url ?? ""),
        });
        for (const waiter of this.opened.get(contents) ?? []) waiter();
      } else if (method === "Page.javascriptDialogClosed") {
        this.dialogs.delete(contents);
      } else if (method === "Page.fileChooserOpened") {
        this.choosers.set(contents, Number(params.backendNodeId));
      } else if (method.startsWith("Network.")) {
        this.networks.get(contents)?.handle(method, params);
      }
    };
    debug.on("message", onMessage);
    debug.once("detach", () => {
      debug.removeListener("message", onMessage);
      this.dialogs.delete(contents);
      this.unanswered.delete(contents);
    });
  }

  private async unlessOpened<T>(
    contents: WebContents,
    work: Promise<T>,
  ): Promise<{ done: T } | { opened: true }> {
    work.catch(() => {});
    let waiters = this.opened.get(contents);
    if (!waiters) {
      waiters = new Set();
      this.opened.set(contents, waiters);
    }
    const set = waiters;
    let wake: () => void = () => {};
    const opened = new Promise<{ opened: true }>((resolve) => {
      wake = () => resolve({ opened: true });
    });
    set.add(wake);
    try {
      return await Promise.race([work.then((done) => ({ done })), opened]);
    } finally {
      set.delete(wake);
    }
  }

  private async act(
    contents: WebContents,
    text: string,
    before: PageMark,
    input: () => Promise<void>,
  ): Promise<ActionResult> {
    this.choosers.delete(contents);
    await this.send(contents, "Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      await input();
    } catch (error) {
      if (!(error instanceof DialogShown)) throw error;
      return {
        text: `${text}\n${error.message}`,
        url: contents.getURL(),
        title: contents.getTitle(),
        navigated: false,
      };
    } finally {
      if (!this.dialogs.has(contents)) {
        await this.send(contents, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(
          () => {},
        );
      }
    }
    const result = await this.after(contents, text, before);
    if (!this.choosers.has(contents)) return result;
    return {
      ...result,
      text: `${result.text}\nIt opened a file chooser, which was not shown; give the input files with nexus browser upload.`,
    };
  }

  private noDialog(contents: WebContents): void {
    const dialog = this.dialogs.get(contents);
    if (dialog) throw new DialogShown(dialog);
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

  private async with<T>(
    tabId: string,
    body: (contents: WebContents, state: TabState) => Promise<T>,
    options: { dialog?: boolean } = {},
  ): Promise<T> {
    const contents = this.contents(tabId);
    if (!options.dialog) this.noDialog(contents);
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

  private withDrawn<T>(
    tabId: string,
    body: (contents: WebContents, state: TabState) => Promise<T>,
  ): Promise<T> {
    return this.with(tabId, (contents, state) => this.parked(tabId, () => body(contents, state)));
  }

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
    } catch {}
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

  private mark(contents: WebContents): PageMark {
    return { url: contents.getURL(), navigations: this.navigations.get(contents) ?? 0 };
  }

  private async after(
    contents: WebContents,
    text: string,
    before: PageMark,
  ): Promise<ActionResult> {
    await this.settleOn(contents);
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

  private checkLoadFailure(tabId: string): void {
    const failure = this.pageOf(tabId)?.loadFailure;
    if (failure?.description === "ERR_RENDER_PROCESS_GONE") {
      throw new CliError(`Page stopped at ${failure.url}. Reload the tab to try again.`);
    }
    if (failure) throw new CliError(`Could not load ${failure.url}: ${failure.description}`);
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
      this.checkLoadFailure(tabId);
      await this.awaitDownload(contents);
    } finally {
      done();
    }
    if (contents.isDestroyed()) return null;
    this.checkLoadFailure(tabId);
    const download = this.downloads.get(contents);
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      ...(download ? { download } : {}),
    };
  }

  async snapshot(
    tabId: string,
    options: { maxLines: number; within?: string },
  ): Promise<PageSnapshot> {
    this.checkLoadFailure(tabId);
    return this.with(tabId, async (contents, state) => {
      if (contents.isLoading()) await once(contents, "did-stop-loading", LOAD_MS);
      this.checkLoadFailure(tabId);
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
      await this.paint(tabId, contents);
      const before = this.mark(contents);
      const what = `${options.double ? "Double-clicked" : "Clicked"} ${el.label}.`;
      return this.act(contents, what, before, async () => {
        const at = await this.pointerOn(contents, el);
        if (!options.force) await this.checkHit(contents, el, at);
        for (let count = 1; count <= (options.double ? 2 : 1); count++) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await this.send(contents, "Input.dispatchMouseEvent", {
              type,
              ...at,
              button: "left",
              buttons: type === "mousePressed" ? 1 : 0,
              clickCount: count,
            });
          }
        }
      });
    });
  }

  hover(tabId: string, target: string, options: { force: boolean }): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.withDrawn(tabId, async (contents, state) => {
      const el = await this.locate(contents, state, target);
      await this.paint(tabId, contents);
      const before = this.mark(contents);
      const at = await this.pointerOn(contents, el);
      if (!options.force) await this.checkHit(contents, el, at);
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
      await this.send(contents, "Input.setInterceptDrags", { enabled: true });
      let data: unknown;
      try {
        const intercepted = this.next(contents, "Input.dragIntercepted", DRAG_INTERCEPT_MS);
        await mouse("mouseMoved", { x: start.x + DRAG_START_PX, y: start.y + DRAG_START_PX });
        data = ((await intercepted) as { data?: unknown } | null)?.data;
      } finally {
        await this.send(contents, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
      }
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

  private async documentObject(contents: WebContents): Promise<string> {
    const res = await this.send<EvaluateResult>(contents, "Runtime.evaluate", {
      expression: "document",
      objectGroup: OBJECT_GROUP,
    });
    const objectId = res.result.objectId;
    if (!objectId) throw new CliError("the page has no document");
    return objectId;
  }

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
    const presses = keys.map((k) => parseBrowserKey(k, this.mac));
    this.notPicking(tabId);
    return this.with(tabId, async (contents) => {
      const before = this.mark(contents);
      return this.act(contents, `Pressed ${keys.join(" ")}.`, before, async () => {
        for (const press of presses) await this.pressKey(contents, press);
      });
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

  upload(tabId: string, target: string, files: readonly string[]): Promise<ActionResult> {
    this.notPicking(tabId);
    return this.with(tabId, async (contents, state) => {
      for (const file of files) {
        const found = await stat(file).catch(() => null);
        if (!found?.isFile()) throw new CliError(`no file at ${file}`);
      }
      const el = await this.locate(contents, state, target);
      const input = await this.call<{ file: boolean; multiple: boolean }>(
        contents,
        el.objectId,
        FILE_INPUT,
      );
      if (!input.file) throw new CliError(`${el.label} is not a file input`);
      if (files.length > 1 && !input.multiple) {
        throw new CliError(`${el.label} takes one file, not ${files.length}`);
      }
      const before = this.mark(contents);
      if (files.length === 0) await this.call(contents, el.objectId, CLEAR_FILES);
      else {
        await this.send(contents, "DOM.setFileInputFiles", {
          files,
          backendNodeId: el.backendNodeId,
        });
      }
      const names = files.map((f) => path.basename(f)).join(", ");
      return this.after(contents, `Gave ${el.label} ${names || "no file"}.`, before);
    });
  }

  dialog(tabId: string): Promise<PageDialog | null> {
    return this.with(
      tabId,
      async (contents) => {
        await this.attach(contents);
        return this.dialogs.get(contents) ?? null;
      },
      { dialog: true },
    );
  }

  answerDialog(tabId: string, accept: boolean): Promise<ActionResult> {
    return this.with(
      tabId,
      async (contents) => {
        const dialog = this.dialogs.get(contents);
        if (!dialog) throw new CliError("the page shows no dialog");
        const before = this.mark(contents);
        await this.send(contents, "Page.handleJavaScriptDialog", { accept });
        this.dialogs.delete(contents);
        contents.emit("-cancel-dialogs");
        await this.send(contents, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(
          () => {},
        );
        const answer = accept ? "OK" : "Cancel";
        return this.after(
          contents,
          `Answered ${answer} to the ${dialog.type} ${JSON.stringify(dialog.message)}.`,
          before,
        );
      },
      { dialog: true },
    );
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

  network(tabId: string, clear: boolean): readonly NetworkEntry[] {
    const contents = this.contents(tabId);
    try {
      this.attachNow(contents);
    } catch {
      return [];
    }
    return this.networks.get(contents)?.read(clear) ?? [];
  }

  request(tabId: string, id: number, maxBody: number): Promise<RequestDetails> {
    return this.with(tabId, async (contents) => {
      await this.attach(contents);
      const found = this.networks.get(contents)?.find(id);
      if (!found) throw new CliError(`no request ${id}; nexus browser network lists them`);
      const { entry, requestId } = found;
      let postData = entry.postData;
      if (postData === undefined && entry.hasPostData) {
        postData = await this.send<{ postData: string }>(contents, "Network.getRequestPostData", {
          requestId,
        }).then(
          (r) => r.postData,
          () => undefined,
        );
      }
      return {
        entry,
        ...(postData !== undefined ? { postData } : {}),
        body: await this.body(contents, entry, requestId, maxBody),
      };
    });
  }

  private async body(
    contents: WebContents,
    entry: NetworkEntry,
    requestId: string,
    maxBody: number,
  ): Promise<ResponseBody> {
    if (entry.redirectedTo !== undefined) return { kind: "none", why: "it redirected" };
    if (entry.failure !== undefined) return { kind: "none", why: "it failed" };
    if (entry.size === undefined) return { kind: "none", why: "it has not finished" };
    try {
      const got = await this.send<{ body: string; base64Encoded: boolean }>(
        contents,
        "Network.getResponseBody",
        { requestId },
      );
      if (got.base64Encoded) {
        const bytes = Buffer.from(got.body, "base64");
        if (!looksLikeText(bytes)) return { kind: "binary", bytes: bytes.length };
        const text = bytes.toString("utf8");
        return { kind: "text", text: text.slice(0, maxBody), length: text.length };
      }
      return { kind: "text", text: got.body.slice(0, maxBody), length: got.body.length };
    } catch (error) {
      if (error instanceof DialogShown) throw error;
      return { kind: "none", why: "the page no longer keeps it" };
    }
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
        return firstMatch(condition.pattern, [contents.getURL()]) !== undefined;
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
          return false;
        }
        return found !== condition.gone;
      }
    }
  }

  cancelPick(tabId: string): void {
    this.picking.get(tabId)?.end("aborted");
  }

  pick(tabId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PickResult> {
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
      const page = this.pageOf(tabId);
      if (page) endInspect(page.contents);
    });
  }

  private notPicking(tabId: string): void {
    if (this.picking.has(tabId)) {
      throw new CliError(
        "the user is picking an element in this browser tab; try again once the pick ends",
      );
    }
  }

  private async pickable(
    tabId: string,
    contents: WebContents,
    control: PickControl,
  ): Promise<void> {
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

  private async inspectMode(
    tabId: string,
    contents: WebContents,
    control: PickControl,
  ): Promise<{ backendNodeId: number } | { cancelled: PickCancel }> {
    await this.send(contents, "DOM.enable");
    await this.send(contents, "Overlay.enable");
    if (control.reason !== null) return { cancelled: control.reason };
    const debug = contents.debugger;
    return new Promise((resolve, reject) => {
      let done = false;
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
    const component = await this.call<PickedComponent | null>(
      contents,
      object.objectId,
      DESCRIBE_COMPONENT,
    ).catch(() => null);
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
    } catch {}
    const ref = remember(state, { backendNodeId, role, name });
    const png =
      details.clip === null
        ? undefined
        : await this.capture(tabId, contents, {
            format: "png",
            clip: { ...details.clip, scale: 1 },
          }).catch(() => undefined);
    return cleanPicked({
      url: contents.getURL(),
      title: contents.getTitle(),
      role,
      name,
      ref,
      ...details,
      ...(png === undefined ? {} : { png }),
      ...(component ? { component } : {}),
    });
  }
}

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

function endInspect(contents: WebContents): void {
  const debug = contents.debugger;
  if (contents.isDestroyed() || !debug.isAttached()) return;
  debug
    .sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} })
    .catch(() => {});
  debug.sendCommand("Overlay.hideHighlight").catch(() => {});
}

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

function scrolledText(
  what: string,
  scroll: Exclude<BrowserScroll, { kind: "to" }>,
  done: Scrolled,
): string {
  const across = scroll.kind === "by" && (scroll.way === "left" || scroll.way === "right");
  const max = Math.max(0, Math.round(across ? done.max.x : done.max.y));
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
