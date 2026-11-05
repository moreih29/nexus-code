/** nexus browser network: the requests a browser tab's pages made. */

import { CliUsageError } from "../args";
import type { RequestDetails } from "../browser/driver";
import { type NetworkEntry, requestFailed } from "../browser/network-log";
import { oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import { clockTime, PAGE_FLAGS, pageOf } from "./browser-control";

const DEFAULT_LAST = 50;
const DEFAULT_BODY_CHARS = 4_000;
/** How much of a URL a line of the list shows. */
const URL_CHARS = 100;

const browserNetwork: CliCommand = {
  path: ["browser", "network"],
  summary: "List the requests a browser tab's pages made, or show one",
  args: "[N]",
  details:
    "The last 500 requests since the tab opened. Given a request's number, shows its\n" +
    "headers, what was sent and what came back, as far as the page still keeps it.\n" +
    "A new tab's first page may leave out the files it loads at once; reload it to see them.",
  flags: {
    failed: { type: "boolean", description: "Only requests that failed or got a 4xx or 5xx" },
    type: {
      type: "string",
      value: "TYPES",
      description: "Only these types, comma separated: fetch, xhr, document, script...",
    },
    url: { type: "string", value: "TEXT", description: "Only requests whose URL has TEXT" },
    last: {
      type: "number",
      value: "N",
      description: `List the last N (default ${DEFAULT_LAST})`,
    },
    body: {
      type: "number",
      value: "N",
      description: `Show up to N characters of the response (default ${DEFAULT_BODY_CHARS})`,
    },
    clear: { type: "boolean", description: "Forget the requests once listed" },
    ...PAGE_FLAGS,
  },
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 1) {
      throw new CliUsageError(`unexpected argument "${positionals[1]}"`);
    }
    const { workspace, tab } = await pageOf(ctx, flags, false);
    if (positionals[0] !== undefined) {
      const id = Number(positionals[0].replace(/^#/, ""));
      if (!Number.isInteger(id) || id < 1) {
        throw new CliUsageError(`a request is a number from the list, not "${positionals[0]}"`);
      }
      const maxBody = (flags.body as number | undefined) ?? DEFAULT_BODY_CHARS;
      if (maxBody < 0) throw new CliUsageError("--body is at least 0");
      const details = await ctx.services.browser.request(tab.id, id, maxBody);
      return output(requestText(details), {
        tabId: tab.id,
        workspaceId: workspace.id,
        ...details,
      });
    }
    const last = (flags.last as number | undefined) ?? DEFAULT_LAST;
    if (last < 1) throw new CliUsageError("--last is at least 1");
    const types =
      flags.type === undefined
        ? undefined
        : new Set((flags.type as string).split(",").map((t) => t.trim().toLowerCase()));
    const text = flags.url as string | undefined;
    const matching = ctx.services.browser
      .network(tab.id, flags.clear === true)
      .filter(
        (e) =>
          (flags.failed !== true || requestFailed(e)) &&
          (types === undefined || types.has(e.type)) &&
          (text === undefined || e.url.includes(text)),
      );
    const shown = matching.slice(-last);
    const lines = [
      table(["#", "TIME", "METHOD", "STATUS", "TYPE", "SIZE", "MS", "URL"], shown.map(row)),
    ];
    if (matching.length > shown.length) {
      lines.unshift(`… ${matching.length - shown.length} earlier; see them with --last`);
    }
    return output(shown.length > 0 ? lines.join("\n") : "No requests.", {
      tabId: tab.id,
      workspaceId: workspace.id,
      requests: shown,
    });
  },
};

function row(entry: NetworkEntry): string[] {
  const failure = entry.failure === undefined ? "" : `  (${entry.failure})`;
  return [
    String(entry.id),
    clockTime(entry.at),
    entry.method,
    statusOf(entry),
    entry.type,
    entry.size === undefined ? "-" : bytes(entry.size),
    entry.ms === undefined ? "-" : String(entry.ms),
    `${oneLine(entry.url, URL_CHARS)}${failure}`,
  ];
}

function statusOf(entry: NetworkEntry): string {
  if (entry.failure !== undefined) return entry.failure === "canceled" ? "canceled" : "failed";
  if (entry.status !== undefined) return String(entry.status);
  return "…";
}

function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

function requestText(details: RequestDetails): string {
  const { entry, postData, body } = details;
  const facts = [
    entry.failure ??
      (entry.status === undefined
        ? "no answer yet"
        : `${entry.status} ${entry.statusText ?? ""}`.trim()),
    entry.type,
    entry.mimeType,
    entry.size === undefined ? undefined : bytes(entry.size),
    entry.ms === undefined ? undefined : `${entry.ms}ms`,
    entry.cached ? "from cache" : undefined,
  ].filter((f): f is string => f !== undefined && f !== "");
  const lines = [`#${entry.id} ${entry.method} ${entry.url}`, facts.join(" · ")];
  if (entry.redirectedTo !== undefined) lines.push(`Redirected to ${entry.redirectedTo}`);
  lines.push("", "Request headers:", ...headerLines(entry.requestHeaders));
  if (entry.hasPostData) {
    lines.push("", "Sent:", postData === undefined ? "  (not kept)" : indent(postData));
  }
  if (entry.responseHeaders !== undefined) {
    lines.push("", "Response headers:", ...headerLines(entry.responseHeaders));
  }
  lines.push("", ...bodyLines(body));
  return lines.join("\n");
}

function bodyLines(body: RequestDetails["body"]): string[] {
  switch (body.kind) {
    case "none":
      return [`No response body: ${body.why}.`];
    case "binary":
      return [`Response: ${bytes(body.bytes)} of binary data.`];
    case "text": {
      if (body.length === 0) return ["Response: empty."];
      const cut = body.length > body.text.length;
      return [
        cut
          ? `Response (first ${body.text.length} of ${body.length} characters; more with --body):`
          : "Response:",
        indent(body.text),
      ];
    }
  }
}

function headerLines(headers: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(headers);
  if (names.length === 0) return ["  (none)"];
  return names.map((name) => `  ${name}: ${headers[name]}`);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export const browserNetworkCommands: CliCommand[] = [browserNetwork];
