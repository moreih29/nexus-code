/**
 * nexus browser snapshot/inspect/click/hover/drag/scroll/fill/type/press/
 * upload/dialog/screenshot/eval/console/wait/pick: reading and driving the
 * page in a browser tab.
 */
import type { CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import { dialogText } from "../browser/dialog";
import type { BrowserScroll, BrowserWaitCondition } from "../browser/driver";
import { BROWSER_KEYS_HELP } from "../browser/keys";
import { cancelledText, cleanPicked, formatPick } from "../browser/pick";
import { type CliContext, CliError, mayChange, resolveWorkspace, shortId } from "../context";
import { callerPath } from "../paths";
import { type CliCommand, output } from "../registry";
import { resolveBrowser, TAB_FLAG } from "./browser";
import { WORKSPACE_FLAG } from "./flags";

const PAGE_FLAGS = { tab: TAB_FLAG, workspace: WORKSPACE_FLAG } as const;

const DEFAULT_SNAPSHOT_LINES = 400;
const DEFAULT_BROWSER_WAIT_MS = 30_000;
const MAX_BROWSER_WAIT_MS = 10 * 60_000;
/** A pick waits on a person, so longer than a wait on the page. */
const DEFAULT_PICK_WAIT_MS = 2 * 60_000;

interface Page {
  readonly workspace: WorkspaceMeta;
  readonly tab: CliTabInfo;
}

/** The browser tab a command is about; `changes` asks consent for another workspace's. */
async function pageOf(
  ctx: CliContext,
  flags: ParsedArgs["flags"],
  changes: boolean,
): Promise<Page> {
  const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
  const tab = await resolveBrowser(ctx, workspace, flags.tab as string | undefined);
  if (changes) await mayChange(ctx, workspace, { kind: "browserControl", detail: tab.title });
  return { workspace, tab };
}

/** Text from the words after the command, or from standard input for "-". */
function textOf(ctx: CliContext, words: readonly string[], what: string): string {
  if (words.length === 0) throw new CliUsageError(`missing <${what}>`);
  if (words.length === 1 && words[0] === "-")
    return (ctx.invocation.stdin ?? "").replace(/\r?\n$/, "");
  return words.join(" ");
}

const TARGET_DETAILS =
  'An element is a ref from the last "nexus browser snapshot", such as e12, or a CSS\n' +
  "selector that matches one element.";

const browserSnapshot: CliCommand = {
  path: ["browser", "snapshot"],
  summary: "Print a browser tab's page as an accessibility tree, with refs",
  details:
    "Each element gets a ref (e1, e2, ...) that browser click, fill and type take, good\n" +
    "until the next snapshot or page load. Frames inside the page are not included.",
  flags: {
    within: {
      type: "string",
      value: "ELEMENT",
      description: "Only this element and what is inside it",
    },
    "max-lines": {
      type: "number",
      value: "N",
      description: `Print at most N lines (default ${DEFAULT_SNAPSHOT_LINES})`,
    },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const maxLines = (flags["max-lines"] as number | undefined) ?? DEFAULT_SNAPSHOT_LINES;
    if (maxLines < 1) throw new CliUsageError("--max-lines is at least 1");
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const snap = await ctx.services.browser.snapshot(tab.id, {
      maxLines,
      ...(flags.within === undefined ? {} : { within: flags.within as string }),
    });
    const lines = [
      `${snap.title || "(untitled)"} — ${snap.url}`,
      snap.text || "(the page shows nothing)",
    ];
    if (snap.omitted > 0) {
      lines.push(
        `… ${snap.omitted} more lines; see part of the page with --within, or more with --max-lines`,
      );
    }
    return output(lines.join("\n"), {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: snap.url,
      title: snap.title,
      snapshot: snap.text,
      omitted: snap.omitted,
    });
  },
};

/** Where a picture of an element of `tab` goes, in the temp directory. */
function picturePath(ctx: CliContext, tab: CliTabInfo, kind: string): string {
  return callerPath(
    ctx,
    `nexus-${kind}-${shortId(tab.id)}-${ctx.services.clock.now()}.png`,
    ctx.invocation.tempDir,
  );
}

const browserInspect: CliCommand = {
  path: ["browser", "inspect"],
  summary: "Describe an element of a browser tab's page, as browser pick does",
  args: "<element>",
  details:
    `${TARGET_DETAILS}\n` +
    "Prints its role and name, its ref, a CSS selector that finds it again (none inside a\n" +
    "shadow root), where it is, its text and HTML, and saves a PNG of it in the temp\n" +
    "directory. It is scrolled into view first.",
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [target] = exactArgs(positionals, "element") as [string];
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const inspected = await ctx.services.browser.inspect(tab.id, target);
    const { png, clip: _clip, ...el } = cleanPicked(inspected);
    const file = png === undefined ? undefined : picturePath(ctx, tab, "inspect");
    return output(
      formatPick(inspected, file),
      { tabId: tab.id, workspaceId: workspace.id, element: { ...el, screenshot: file ?? null } },
      png === undefined || file === undefined ? {} : { files: [{ path: file, base64: png }] },
    );
  },
};

const browserClick: CliCommand = {
  path: ["browser", "click"],
  summary: "Click an element in a browser tab",
  args: "<element>",
  details: `${TARGET_DETAILS}\nRefused when something else covers its middle, unless --force.`,
  flags: {
    double: { type: "boolean", description: "Double-click" },
    force: { type: "boolean", description: "Click its spot even when something covers it" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    const [target] = exactArgs(positionals, "element") as [string];
    const { workspace, tab } = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.click(tab.id, target, {
      double: flags.double === true,
      force: flags.force === true,
    });
    return output(done.text, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: done.url,
      navigated: done.navigated,
    });
  },
};

/** What a command that acted on a page gives with --json. */
function acted(page: Page, done: { url: string; navigated: boolean }) {
  return {
    tabId: page.tab.id,
    workspaceId: page.workspace.id,
    url: done.url,
    navigated: done.navigated,
  };
}

const browserHover: CliCommand = {
  path: ["browser", "hover"],
  summary: "Move the mouse over an element in a browser tab",
  args: "<element>",
  details:
    `${TARGET_DETAILS}\nThe mouse stays there, so menus and tooltips it opens stay open for a\n` +
    "snapshot or a screenshot. Refused when something else covers it, unless --force.",
  flags: {
    force: { type: "boolean", description: "Hover its spot even when something covers it" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    const [target] = exactArgs(positionals, "element") as [string];
    const page = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.hover(page.tab.id, target, {
      force: flags.force === true,
    });
    return output(done.text, acted(page, done));
  },
};

const browserDrag: CliCommand = {
  path: ["browser", "drag"],
  summary: "Drag an element onto another in a browser tab",
  args: "<element> <onto>",
  details:
    `${TARGET_DETAILS}\nThe mouse presses on the first, moves to the middle of the second and lets\n` +
    "go. Pages that use HTML drag and drop get its events; ones that follow the mouse get\n" +
    "its moves.",
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [from, to] = exactArgs(positionals, "element", "onto") as [string, string];
    const page = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.drag(page.tab.id, from, to);
    return output(done.text, acted(page, done));
  },
};

const SCROLL_WAYS = ["up", "down", "left", "right"] as const;
const SCROLL_ENDS = ["top", "bottom"] as const;

function scrollOf(where: string, by: number | undefined): BrowserScroll {
  const word = where.toLowerCase();
  const way = SCROLL_WAYS.find((w) => w === word);
  if (way) {
    if (by !== undefined && by <= 0) throw new CliUsageError("--by is a distance above 0");
    return { kind: "by", way, ...(by === undefined ? {} : { amount: by }) };
  }
  if (by !== undefined) throw new CliUsageError("--by goes with up, down, left or right");
  const end = SCROLL_ENDS.find((e) => e === word);
  return end ? { kind: "end", end } : { kind: "to", target: where };
}

const browserScroll: CliCommand = {
  path: ["browser", "scroll"],
  summary: "Scroll a browser tab's page or an element, or scroll an element into view",
  args: "<up|down|left|right|top|bottom|element>",
  details:
    "up, down, left and right go most of a view's worth, or --by pixels; top and bottom go\n" +
    "to the end. An element instead is scrolled into view. --within scrolls an element that\n" +
    `scrolls by itself, such as a list, instead of the page.\n${TARGET_DETAILS}`,
  flags: {
    by: { type: "number", value: "PX", description: "How far, in CSS pixels" },
    within: { type: "string", value: "ELEMENT", description: "Scroll this element" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    const [where] = exactArgs(positionals, "where") as [string];
    const scroll = scrollOf(where, flags.by as number | undefined);
    const within = flags.within as string | undefined;
    if (scroll.kind === "to" && within !== undefined) {
      throw new CliUsageError("--within goes with a way or an end, not an element");
    }
    const page = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.scroll(page.tab.id, scroll, within);
    return output(done.text, acted(page, done));
  },
};

const browserFill: CliCommand = {
  path: ["browser", "fill"],
  summary: "Replace the text of a field, or choose an option of a select",
  args: "<element> <text...>",
  details: `${TARGET_DETAILS}\n"" empties the field; "-" reads the text from standard input.`,
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [target, ...words] = positionals;
    if (target === undefined) throw new CliUsageError("missing <element>");
    const text = textOf(ctx, words, "text");
    const { workspace, tab } = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.fill(tab.id, target, text);
    return output(done.text, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: done.url,
      navigated: done.navigated,
    });
  },
};

const browserType: CliCommand = {
  path: ["browser", "type"],
  summary: "Type text where the page's focus is, or into an element",
  args: "<text...>",
  details: `Adds to what is there; browser fill replaces it. "-" reads the text from standard input.\n${TARGET_DETAILS}`,
  flags: {
    into: { type: "string", value: "ELEMENT", description: "Focus this element first" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    const text = textOf(ctx, positionals, "text");
    const { workspace, tab } = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.type(tab.id, text, flags.into as string | undefined);
    return output(done.text, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: done.url,
      navigated: done.navigated,
    });
  },
};

const browserPress: CliCommand = {
  path: ["browser", "press"],
  summary: "Press keys in a browser tab, one after another",
  args: "<key...>",
  details: BROWSER_KEYS_HELP,
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    if (positionals.length === 0) throw new CliUsageError("missing <key>");
    const { workspace, tab } = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.press(tab.id, positionals);
    return output(done.text, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: done.url,
      navigated: done.navigated,
    });
  },
};

const browserUpload: CliCommand = {
  path: ["browser", "upload"],
  summary: "Give a file input of a browser tab files, as choosing them does",
  args: "<element> <file...>",
  details:
    `${TARGET_DETAILS}\nFiles are from this directory, on this computer: the app's tabs read\n` +
    "files where the app runs, so a terminal on an SSH host or in WSL cannot give its own.\n" +
    'No file, as "", empties the input.',
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    const [target, ...inputs] = positionals;
    if (target === undefined) throw new CliUsageError("missing <element>");
    if (inputs.length === 0) throw new CliUsageError("missing <file>");
    const own = resolveWorkspace(ctx, undefined);
    if (own.location.kind !== "local") {
      throw new CliError(
        "upload takes files of the computer the app runs on, and this terminal is on another",
      );
    }
    const files = inputs.filter((f) => f !== "").map((f) => callerPath(ctx, f));
    const page = await pageOf(ctx, flags, true);
    const done = await ctx.services.browser.upload(page.tab.id, target, files);
    return output(done.text, { ...acted(page, done), files });
  },
};

const browserDialog: CliCommand = {
  path: ["browser", "dialog"],
  summary: "Show the dialog a browser tab's page opened, or answer it",
  args: "[accept|dismiss]",
  details:
    "An alert, a confirm, or a page asking before it is left holds the page up, and every\n" +
    "command on it, until it is answered: accept is OK, dismiss is Cancel. A click or a key\n" +
    "that opens one says so. The user sees it too and may answer it first. Electron pages\n" +
    "have no prompt().",
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 1) throw new CliUsageError(`unexpected argument "${positionals[1]}"`);
    const [answer] = positionals;
    if (answer !== undefined && answer !== "accept" && answer !== "dismiss") {
      throw new CliUsageError(`answer accept or dismiss, not "${answer}"`);
    }
    const page = await pageOf(ctx, flags, answer !== undefined);
    if (answer === undefined) {
      const dialog = await ctx.services.browser.dialog(page.tab.id);
      return output(dialog ? dialogText(dialog) : "The page shows no dialog.", {
        tabId: page.tab.id,
        workspaceId: page.workspace.id,
        dialog,
      });
    }
    const done = await ctx.services.browser.answerDialog(page.tab.id, answer === "accept");
    return output(done.text, acted(page, done));
  },
};

const browserScreenshot: CliCommand = {
  path: ["browser", "screenshot"],
  summary: "Save a PNG of a browser tab's page",
  details:
    "Saved where --out says, from this directory, or in the temp directory. Works for tabs\n" +
    "that are not shown, too. --element takes a ref from the last snapshot or a CSS selector\n" +
    "that matches one element, and scrolls it into view.",
  flags: {
    out: { type: "string", value: "FILE", description: "Save it as FILE" },
    full: { type: "boolean", description: "The whole page, not only what fits the tab" },
    element: { type: "string", value: "ELEMENT", description: "Only this element, cut to it" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const element = flags.element as string | undefined;
    if (element !== undefined && flags.full === true) {
      throw new CliUsageError("give --full or --element, not both");
    }
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const base64 = await ctx.services.browser.screenshot(tab.id, {
      full: flags.full === true,
      ...(element === undefined ? {} : { element }),
    });
    const file =
      flags.out === undefined
        ? picturePath(ctx, tab, "browser")
        : callerPath(ctx, flags.out as string);
    return output(
      `Saved ${file}`,
      { tabId: tab.id, workspaceId: workspace.id, path: file },
      { files: [{ path: file, base64 }] },
    );
  },
};

function printable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

const browserEval: CliCommand = {
  path: ["browser", "eval"],
  summary: "Run JavaScript in a browser tab's page and print what it gives",
  args: "<script...>",
  details:
    "The script runs as the console runs it: await works, and the last expression is the\n" +
    'result, printed as JSON unless a string. "-" reads the script from standard input.',
  flags: PAGE_FLAGS,
  async run(ctx, { positionals, flags }) {
    const script = textOf(ctx, positionals, "script");
    const { workspace, tab } = await pageOf(ctx, flags, true);
    const value = await ctx.services.browser.evaluate(tab.id, script);
    return output(printable(value), {
      tabId: tab.id,
      workspaceId: workspace.id,
      value: value ?? null,
    });
  },
};

function clockTime(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

const browserConsole: CliCommand = {
  path: ["browser", "console"],
  summary: "Print what a browser tab's pages logged to the console",
  details: `The last 500 messages since the tab opened, with a line for each page it loaded.`,
  flags: {
    errors: { type: "boolean", description: "Only errors and warnings" },
    clear: { type: "boolean", description: "Forget the messages once printed" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const all = ctx.services.browser.console(tab.id, flags.clear === true);
    const entries =
      flags.errors === true
        ? all.filter((e) => e.level === "error" || e.level === "warning" || e.level === "page")
        : all;
    const lines = entries.map((e) =>
      e.level === "page"
        ? `${clockTime(e.at)} ── loaded ${e.text}`
        : `${clockTime(e.at)} ${e.level.padEnd(7)} ${e.text}${e.source ? `  (${e.source})` : ""}`,
    );
    return output(lines.length > 0 ? lines.join("\n") : "No console messages.", {
      tabId: tab.id,
      workspaceId: workspace.id,
      entries,
    });
  },
};

function waitCondition(flags: ParsedArgs["flags"]): BrowserWaitCondition {
  const gone = flags.gone === true;
  const given = ["text", "selector", "url"].filter((f) => flags[f] !== undefined);
  if (given.length > 1) throw new CliUsageError("give one of --text, --selector and --url");
  if (gone && (given[0] === undefined || given[0] === "url")) {
    throw new CliUsageError("--gone goes with --text or --selector");
  }
  if (flags.text !== undefined) return { kind: "text", text: flags.text as string, gone };
  if (flags.selector !== undefined)
    return { kind: "selector", selector: flags.selector as string, gone };
  if (flags.url !== undefined) {
    try {
      return { kind: "url", pattern: new RegExp(flags.url as string) };
    } catch {
      throw new CliUsageError(`--url takes a regular expression, not ${JSON.stringify(flags.url)}`);
    }
  }
  return { kind: "load" };
}

function waitedFor(condition: BrowserWaitCondition): string {
  switch (condition.kind) {
    case "load":
      return "the page to load";
    case "url":
      return `a URL matching ${condition.pattern.source}`;
    case "text":
      return `${condition.gone ? "the text to go" : "the text"} ${JSON.stringify(condition.text)}`;
    case "selector":
      return `${condition.gone ? "no element" : "an element"} matching ${condition.selector}`;
  }
}

const browserWait: CliCommand = {
  path: ["browser", "wait"],
  summary: "Wait until a browser tab's page has loaded, or shows or loses something",
  details:
    "Without --text, --selector or --url it waits for the page to load. Exits 124 when the\n" +
    "wait runs out.",
  flags: {
    text: { type: "string", value: "TEXT", description: "Until the page shows TEXT" },
    selector: {
      type: "string",
      value: "CSS",
      description: "Until an element matching CSS is visible",
    },
    url: { type: "string", value: "REGEX", description: "Until the tab's URL matches REGEX" },
    gone: { type: "boolean", description: "With --text or --selector: until it is gone" },
    timeout: {
      type: "string",
      value: "DURATION",
      description: "Give up after DURATION (default 30s, at most 10m)",
    },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const condition = waitCondition(flags);
    const timeoutMs =
      flags.timeout === undefined
        ? DEFAULT_BROWSER_WAIT_MS
        : parseDuration(flags.timeout as string, "timeout");
    if (timeoutMs > MAX_BROWSER_WAIT_MS) throw new CliUsageError("--timeout is at most 10m");
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const met = await ctx.services.browser.waitFor(tab.id, condition, timeoutMs);
    const what = waitedFor(condition);
    return output(
      met ? `Done waiting for ${what}.` : `Gave up waiting for ${what}.`,
      { tabId: tab.id, workspaceId: workspace.id, met },
      met ? {} : { exitCode: 124 },
    );
  },
};

const browserPick: CliCommand = {
  path: ["browser", "pick"],
  summary: "Wait for the user to click an element in a browser tab, and describe it",
  details:
    "Shows the tab and highlights what is under the mouse; the user's click picks that element\n" +
    "instead of clicking it, and Esc cancels. Prints its role and name, a ref that browser click,\n" +
    "fill and type take, a CSS selector (none inside a shadow root), where it is, its text and\n" +
    "HTML, and saves a PNG of it in the temp directory. Exits 124 when no element is picked in\n" +
    "time. While it waits, click, fill, type and press on that tab are refused.",
  flags: {
    timeout: {
      type: "string",
      value: "DURATION",
      description: "Give up after DURATION (default 2m, at most 10m)",
    },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const timeoutMs =
      flags.timeout === undefined
        ? DEFAULT_PICK_WAIT_MS
        : parseDuration(flags.timeout as string, "timeout");
    if (timeoutMs > MAX_BROWSER_WAIT_MS) throw new CliUsageError("--timeout is at most 10m");
    const { workspace, tab } = await pageOf(ctx, flags, false);
    await ctx.services.ui("tab.show", { workspaceId: workspace.id, tabId: tab.id });
    const result = await ctx.services.browser.pick(tab.id, {
      timeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const ids = { tabId: tab.id, workspaceId: workspace.id };
    if ("cancelled" in result) {
      if (result.cancelled !== "timeout") throw new CliError(cancelledText(result.cancelled));
      return output("No element was picked in time.", { ...ids, picked: null }, { exitCode: 124 });
    }
    const { png, clip: _clip, ...el } = cleanPicked(result.picked);
    const file = png === undefined ? undefined : picturePath(ctx, tab, "pick");
    return output(
      formatPick(result.picked, file),
      { ...ids, picked: { ...el, screenshot: file ?? null } },
      png === undefined || file === undefined ? {} : { files: [{ path: file, base64: png }] },
    );
  },
};

export const browserControlCommands: CliCommand[] = [
  browserSnapshot,
  browserInspect,
  browserClick,
  browserHover,
  browserDrag,
  browserScroll,
  browserFill,
  browserType,
  browserPress,
  browserUpload,
  browserDialog,
  browserScreenshot,
  browserEval,
  browserConsole,
  browserWait,
  browserPick,
];
