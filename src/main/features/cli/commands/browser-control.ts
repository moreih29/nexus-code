/**
 * nexus browser snapshot/click/fill/type/press/screenshot/eval/console/wait:
 * reading and driving the page in a browser tab.
 */
import type { CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import type { BrowserWaitCondition } from "../browser/driver";
import { BROWSER_KEYS_HELP } from "../browser/keys";
import { type CliContext, mayChange, resolveWorkspace, shortId } from "../context";
import { callerPath } from "../paths";
import { type CliCommand, output } from "../registry";
import { resolveBrowser, TAB_FLAG } from "./browser";
import { WORKSPACE_FLAG } from "./flags";

const PAGE_FLAGS = { tab: TAB_FLAG, workspace: WORKSPACE_FLAG } as const;

const DEFAULT_SNAPSHOT_LINES = 400;
const DEFAULT_BROWSER_WAIT_MS = 30_000;
const MAX_BROWSER_WAIT_MS = 10 * 60_000;

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

const browserScreenshot: CliCommand = {
  path: ["browser", "screenshot"],
  summary: "Save a PNG of a browser tab's page",
  details:
    "Saved where --out says, from this directory, or in the temp directory. Works for tabs\n" +
    "that are not shown, too.",
  flags: {
    out: { type: "string", value: "FILE", description: "Save it as FILE" },
    full: { type: "boolean", description: "The whole page, not only what fits the tab" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const { workspace, tab } = await pageOf(ctx, flags, false);
    const base64 = await ctx.services.browser.screenshot(tab.id, { full: flags.full === true });
    const file =
      flags.out === undefined
        ? callerPath(
            ctx,
            `nexus-browser-${shortId(tab.id)}-${ctx.services.clock.now()}.png`,
            ctx.invocation.tempDir,
          )
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

export const browserControlCommands: CliCommand[] = [
  browserSnapshot,
  browserClick,
  browserFill,
  browserType,
  browserPress,
  browserScreenshot,
  browserEval,
  browserConsole,
  browserWait,
];
