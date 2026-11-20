/**
 * A minimal TOML editor for config.toml. The repo has no TOML library, and
 * the file is the user's own (comments, blank lines, the order of keys,
 * tables of other settings): a key is read, set or removed by editing its own
 * line, and every other byte stays.
 *
 * It scans the file statement by statement (tables, key = value, with dotted
 * and quoted keys, strings of every kind, arrays and inline tables skipped
 * whole) to know where each key is; a file it cannot scan is "broken", and
 * a key whose shape it cannot change safely (an inline table, an array, a
 * table defined in parts) is "unsupported": the caller says to edit the file.
 */

export type TomlScalar = string | number | boolean;

export class TomlSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

type ValueKind = "string" | "int" | "bool" | "other";

interface Statement {
  /** The table (header) the statement is in. */
  table: string[];
  /** The key as written, dotted parts apart. */
  key: string[];
  /** table + key. */
  full: string[];
  /** The start of the statement's line, and the end of its last line (after its newline). */
  lineStart: number;
  lineEnd: number;
  valueStart: number;
  valueEnd: number;
  kind: ValueKind;
  /** The scalar, when the value is one this editor reads (string, integer, boolean). */
  value?: TomlScalar;
  /** An inline table or an array. */
  composite: boolean;
}

interface Header {
  path: string[];
  array: boolean;
  lineStart: number;
  lineEnd: number;
}

interface Scan {
  statements: Statement[];
  headers: Header[];
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
  const at = text.indexOf("\n", offset);
  return at < 0 ? text.length : at + 1;
}

/** Reads a basic string ("…") at `i`; returns its text and where it ends. */
function readBasicString(text: string, i: number): { value: string; end: number } {
  let out = "";
  let p = i + 1;
  for (;;) {
    const ch = text[p];
    if (ch === undefined || ch === "\n") throw new TomlSyntaxError("unterminated string", i);
    if (ch === '"') return { value: out, end: p + 1 };
    if (ch === "\\") {
      const next = text[p + 1];
      const simple: Record<string, string> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (next !== undefined && next in simple) {
        out += simple[next];
        p += 2;
      } else if (next === "u" || next === "U") {
        const len = next === "u" ? 4 : 8;
        const hex = text.slice(p + 2, p + 2 + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex))
          throw new TomlSyntaxError("bad escape", p);
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        p += 2 + len;
      } else throw new TomlSyntaxError("bad escape", p);
      continue;
    }
    out += ch;
    p += 1;
  }
}

function readLiteralString(text: string, i: number): { value: string; end: number } {
  const close = text.indexOf("'", i + 1);
  const nl = text.indexOf("\n", i + 1);
  if (close < 0 || (nl >= 0 && nl < close)) throw new TomlSyntaxError("unterminated string", i);
  return { value: text.slice(i + 1, close), end: close + 1 };
}

/** A """…""" or '''…''' string at `i`; its text is not read (the caller needs only where it ends). */
function skipMultiline(text: string, i: number, quote: string): number {
  const fence = quote.repeat(3);
  let p = i + 3;
  for (;;) {
    const at = text.indexOf(fence, p);
    if (at < 0) throw new TomlSyntaxError("unterminated multi-line string", i);
    if (quote === '"') {
      // An escaped quote does not close it.
      let backslashes = 0;
      for (let q = at - 1; q >= p && text[q] === "\\"; q--) backslashes++;
      if (backslashes % 2 === 1) {
        p = at + 1;
        continue;
      }
    }
    // Up to two more quotes may belong to the string's end.
    let end = at + 3;
    while (end < at + 5 && text[end] === quote) end++;
    return end;
  }
}

/** Skips spaces, newlines and comments between the items of an array or inline table. */
function skipSpaceAndComments(text: string, i: number, newlines: boolean): number {
  let p = i;
  for (;;) {
    const ch = text[p];
    if (isSpace(ch) || (newlines && (ch === "\n" || ch === "\r"))) p++;
    else if (ch === "#") {
      while (p < text.length && text[p] !== "\n") p++;
    } else return p;
  }
}

interface ValueRead {
  end: number;
  kind: ValueKind;
  value?: TomlScalar;
  composite: boolean;
}

function readValue(text: string, i: number): ValueRead {
  const ch = text[i];
  if (ch === '"') {
    if (text.startsWith('"""', i))
      return { end: skipMultiline(text, i, '"'), kind: "other", composite: true };
    const s = readBasicString(text, i);
    return { end: s.end, kind: "string", value: s.value, composite: false };
  }
  if (ch === "'") {
    if (text.startsWith("'''", i))
      return { end: skipMultiline(text, i, "'"), kind: "other", composite: true };
    const s = readLiteralString(text, i);
    return { end: s.end, kind: "string", value: s.value, composite: false };
  }
  if (ch === "[") {
    let p = skipSpaceAndComments(text, i + 1, true);
    if (text[p] === "]") return { end: p + 1, kind: "other", composite: true };
    for (;;) {
      p = readValue(text, p).end;
      p = skipSpaceAndComments(text, p, true);
      if (text[p] === ",") {
        p = skipSpaceAndComments(text, p + 1, true);
        if (text[p] === "]") return { end: p + 1, kind: "other", composite: true };
      } else if (text[p] === "]") return { end: p + 1, kind: "other", composite: true };
      else throw new TomlSyntaxError("bad array", p);
    }
  }
  if (ch === "{") {
    let p = skipSpaceAndComments(text, i + 1, false);
    if (text[p] === "}") return { end: p + 1, kind: "other", composite: true };
    for (;;) {
      p = readKey(text, p).end;
      p = skipSpaceAndComments(text, p, false);
      if (text[p] !== "=") throw new TomlSyntaxError("expected =", p);
      p = skipSpaceAndComments(text, p + 1, false);
      p = readValue(text, p).end;
      p = skipSpaceAndComments(text, p, false);
      if (text[p] === ",") p = skipSpaceAndComments(text, p + 1, false);
      else if (text[p] === "}") return { end: p + 1, kind: "other", composite: true };
      else throw new TomlSyntaxError("bad inline table", p);
    }
  }
  // A bare value: a boolean, a number, a date.
  let p = i;
  while (p < text.length && !/[\s,\]}#]/.test(text[p] as string)) p++;
  // A date-time may have a space between its date and time.
  if (/^\d{4}-\d\d-\d\d$/.test(text.slice(i, p)) && /^ \d\d:\d\d/.test(text.slice(p, p + 6))) {
    p += 1;
    while (p < text.length && !/[\s,\]}#]/.test(text[p] as string)) p++;
  }
  const raw = text.slice(i, p);
  if (raw === "") throw new TomlSyntaxError("missing value", i);
  if (raw === "true") return { end: p, kind: "bool", value: true, composite: false };
  if (raw === "false") return { end: p, kind: "bool", value: false, composite: false };
  if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw))
    return {
      end: p,
      kind: "int",
      value: Number.parseInt(raw.replace(/_/g, ""), 10),
      composite: false,
    };
  if (
    /^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(raw) ||
    /^0o[0-7](_?[0-7])*$/.test(raw) ||
    /^0b[01](_?[01])*$/.test(raw) ||
    /^[+-]?(\d(_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw) ||
    /^[+-]?(inf|nan)$/.test(raw) ||
    /^\d{4}-\d\d-\d\d([Tt ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?)?$/.test(raw) ||
    /^\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(raw)
  )
    return { end: p, kind: "other", composite: false };
  throw new TomlSyntaxError(`bad value ${raw}`, i);
}

/** A dotted key (`a . "b".c`) at `i`; its parts and where it ends. */
function readKey(text: string, i: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let p = i;
  for (;;) {
    while (isSpace(text[p])) p++;
    const ch = text[p];
    if (ch === '"') {
      const s = readBasicString(text, p);
      parts.push(s.value);
      p = s.end;
    } else if (ch === "'") {
      const s = readLiteralString(text, p);
      parts.push(s.value);
      p = s.end;
    } else {
      const from = p;
      while (p < text.length && BARE_KEY.test(text[p] as string)) p++;
      if (p === from) throw new TomlSyntaxError("expected a key", p);
      parts.push(text.slice(from, p));
    }
    let q = p;
    while (isSpace(text[q])) q++;
    if (text[q] === ".") {
      p = q + 1;
      continue;
    }
    return { parts, end: q };
  }
}

/** The end of a statement's line: spaces and a comment only. */
function endOfStatement(text: string, i: number): number {
  let p = i;
  while (isSpace(text[p])) p++;
  if (text[p] === "#") {
    while (p < text.length && text[p] !== "\n") p++;
  }
  if (text[p] === "\r" && text[p + 1] === "\n") p++;
  if (p < text.length && text[p] !== "\n") throw new TomlSyntaxError("unexpected text", p);
  return p;
}

/** Scans the file; throws TomlSyntaxError when it is not TOML this editor can follow. */
function scan(text: string): Scan {
  const statements: Statement[] = [];
  const headers: Header[] = [];
  let table: string[] = [];
  let inArrayTable = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r" || isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    const lineStart = lineStartOf(text, i);
    if (ch === "[") {
      const array = text[i + 1] === "[";
      const key = readKey(text, i + (array ? 2 : 1));
      let p = key.end;
      while (isSpace(text[p])) p++;
      if (array ? text.slice(p, p + 2) !== "]]" : text[p] !== "]")
        throw new TomlSyntaxError("bad table header", p);
      p += array ? 2 : 1;
      const end = endOfStatement(text, p);
      table = key.parts;
      inArrayTable = array;
      headers.push({ path: key.parts, array, lineStart, lineEnd: lineEndOf(text, end) });
      i = end;
      continue;
    }
    const key = readKey(text, i);
    let p = key.end;
    if (text[p] !== "=") throw new TomlSyntaxError("expected =", p);
    p += 1;
    while (isSpace(text[p])) p++;
    const valueStart = p;
    const value = readValue(text, p);
    const end = endOfStatement(text, value.end);
    statements.push({
      table: inArrayTable ? ["[[]]", ...table] : table,
      key: key.parts,
      full: [...(inArrayTable ? ["[[]]", ...table] : table), ...key.parts],
      lineStart,
      lineEnd: lineEndOf(text, end),
      valueStart,
      valueEnd: value.end,
      kind: value.kind,
      value: value.value,
      composite: value.composite,
    });
    i = end;
  }
  return { statements, headers };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, n) => part === b[n]);
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, n) => part === path[n]);
}

export type TomlRead =
  | { state: "absent" }
  | { state: "value"; value: TomlScalar }
  /** The key is there in a shape this editor does not read or change. */
  | { state: "unsupported" };

/** The value at `path`. Throws TomlSyntaxError for a file that is not TOML. */
export function readTomlKey(text: string, path: readonly string[]): TomlRead {
  return readFrom(scan(text), path);
}

function readFrom(found: Scan, path: readonly string[]): TomlRead {
  const exact = found.statements.filter((s) => samePath(s.full, path));
  const below =
    found.statements.some((s) => s.full.length > path.length && startsWith(s.full, path)) ||
    found.headers.some((h) => startsWith(h.path, path) && h.path.length > path.length);
  // A table or inline table where a value is, or the key set twice.
  const parentSet = found.statements.some(
    (s) => s.full.length < path.length && startsWith(path, s.full),
  );
  if (exact.length === 0)
    return below || parentSet ? { state: "unsupported" } : { state: "absent" };
  const only = exact[0];
  if (exact.length > 1 || below || !only || only.value === undefined)
    return { state: "unsupported" };
  return { state: "value", value: only.value };
}

export type TomlEdit = { path: readonly string[]; value: TomlScalar | undefined };

export type TomlEditResult =
  | { ok: true; text: string }
  | { ok: false; reason: "broken" | "unsupported"; message: string; path?: readonly string[] };

function formatValue(value: TomlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function formatKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part);
}

/**
 * Sets each edit's key to its value, or removes it (value undefined), and
 * leaves the rest of the text as it is.
 */
export function editToml(text: string, edits: readonly TomlEdit[]): TomlEditResult {
  let current = text;
  for (const edit of edits) {
    let result: TomlEditResult;
    try {
      result = editOne(current, edit);
    } catch (error) {
      if (!(error instanceof TomlSyntaxError)) throw error;
      return { ok: false, reason: "broken", message: error.message };
    }
    if (!result.ok) return result;
    current = result.text;
  }
  return { ok: true, text: current };
}

function unsupported(path: readonly string[]): TomlEditResult {
  return {
    ok: false,
    reason: "unsupported",
    message: `${path.join(".")} is not a plain value`,
    path,
  };
}

function editOne(text: string, edit: TomlEdit): TomlEditResult {
  const { path, value } = edit;
  const found = scan(text);
  const read = readFrom(found, path);
  if (read.state === "unsupported") return unsupported(path);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  if (read.state === "value") {
    const statement = found.statements.find((s) => samePath(s.full, path)) as Statement;
    if (value === undefined)
      return { ok: true, text: text.slice(0, statement.lineStart) + text.slice(statement.lineEnd) };
    return {
      ok: true,
      text:
        text.slice(0, statement.valueStart) + formatValue(value) + text.slice(statement.valueEnd),
    };
  }
  if (value === undefined) return { ok: true, text };

  const key = path[path.length - 1] as string;
  const parent = path.slice(0, -1);
  const withNewline = (s: string) => (s.endsWith("\n") || s === "" ? s : s + eol);

  // A top-level key goes after the last top-level statement, or before the first table.
  if (parent.length === 0) {
    const top = found.statements.filter((s) => s.table.length === 0);
    const line = `${formatKey(key)} = ${formatValue(value)}${eol}`;
    const last = top[top.length - 1];
    if (last) return insertAt(text, last.lineEnd, line, eol);
    const firstHeader = found.headers[0];
    if (!firstHeader) return { ok: true, text: withNewline(text) + line };
    // Before the comments just above the first table, which belong to it.
    let at = firstHeader.lineStart;
    while (at > 0) {
      const prev = lineStartOf(text, at - 1);
      const content = text.slice(prev, at).trim();
      if (!content.startsWith("#")) break;
      at = prev;
    }
    return { ok: true, text: text.slice(0, at) + line + eol + text.slice(at) };
  }

  // Into a table that has a header: after its last key, or right below the header.
  const header = found.headers.find((h) => !h.array && samePath(h.path, parent));
  const dottedSibling = [...found.statements]
    .reverse()
    .find((s) => s.key.length > 1 && samePath(s.full.slice(0, -1), parent) && s.table.length === 0);
  if (header) {
    const inside = found.statements.filter((s) => samePath(s.table, parent));
    const last = inside[inside.length - 1];
    const line = `${formatKey(key)} = ${formatValue(value)}${eol}`;
    return insertAt(text, last ? last.lineEnd : header.lineEnd, line, eol);
  }
  // The table is made by dotted keys at the top: a dotted key next to them.
  if (dottedSibling) {
    const line = `${[...dottedSibling.key.slice(0, -1), key].map(formatKey).join(".")} = ${formatValue(value)}${eol}`;
    return insertAt(text, dottedSibling.lineEnd, line, eol);
  }
  // No table yet: a new one at the end of the file.
  const block = `[${parent.map(formatKey).join(".")}]${eol}${formatKey(key)} = ${formatValue(value)}${eol}`;
  const body = withNewline(text);
  const gap = body === "" || body.endsWith(`${eol}${eol}`) ? "" : eol;
  return { ok: true, text: body + gap + block };
}

function insertAt(text: string, at: number, line: string, eol: string): TomlEditResult {
  // `at` is a line end; the last line may have none.
  const head = text.slice(0, at);
  const lead = head === "" || head.endsWith("\n") ? "" : eol;
  return { ok: true, text: head + lead + line + text.slice(at) };
}

/** Whether the text is TOML this editor can follow. */
export function checkToml(text: string): string | null {
  try {
    scan(text);
    return null;
  } catch (error) {
    if (error instanceof TomlSyntaxError) {
      const line = text.slice(0, error.offset).split("\n").length;
      return `line ${line}: ${error.message}`;
    }
    throw error;
  }
}
