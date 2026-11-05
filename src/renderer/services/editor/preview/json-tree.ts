// A JSON file as a tree of values, for its preview.
//
// The parser takes what configuration files are written in as well:
// comments (`//` and `/* */`) and a comma after the last member, as
// tsconfig.json and VS Code's settings have. Numbers keep the text they
// are written in, so one beyond a double's precision shows as written.
// Members keep their order, a key written twice included. It runs with
// a stack of its own, so a deeply nested file does not overflow the
// call stack.

export type JsonValue =
  | { readonly kind: "object"; readonly entries: JsonEntry[] }
  | { readonly kind: "array"; readonly items: JsonValue[] }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" };

export interface JsonEntry {
  readonly key: string;
  readonly value: JsonValue;
}

type ObjectValue = Extract<JsonValue, { kind: "object" }>;
type ArrayValue = Extract<JsonValue, { kind: "array" }>;

/** Where the text stops being JSON, by line and column from 1. */
export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

type Frame = { node: ObjectValue; key: string | null } | { node: ArrayValue };

export function parseJson(text: string): JsonValue {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Frame[] = [];
  let root: JsonValue | undefined;

  const fail = (message: string, at = i): never => {
    let line = 1;
    let lineStart = 0;
    for (let k = text.indexOf("\n"); k !== -1 && k < at; k = text.indexOf("\n", k + 1)) {
      line++;
      lineStart = k + 1;
    }
    throw new JsonSyntaxError(message, line, at - lineStart + 1);
  };

  const skip = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        i++;
      } else if (c === 0x2f && text.charCodeAt(i + 1) === 0x2f) {
        const end = text.indexOf("\n", i + 2);
        i = end === -1 ? text.length : end + 1;
      } else if (c === 0x2f && text.charCodeAt(i + 1) === 0x2a) {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("Unterminated comment");
        i = end + 2;
      } else {
        return;
      }
    }
  };

  const readString = (): string => {
    let out = "";
    let start = ++i;
    for (;;) {
      const c = text.charCodeAt(i);
      if (Number.isNaN(c)) fail("Unterminated string");
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1] ?? "";
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Bad unicode escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else {
          const char = ESCAPES[e];
          if (char === undefined) fail("Bad escape");
          out += char;
          i += 2;
        }
        start = i;
        continue;
      }
      if (c < 0x20) fail("Control character in string");
      i++;
    }
  };

  const readKey = (frame: Frame) => {
    skip();
    if (text[i] !== '"') fail("Expected a key in quotes");
    const key = readString();
    skip();
    if (text[i] !== ":") fail("Expected :");
    i++;
    (frame as { key: string | null }).key = key;
  };

  const readScalar = (): JsonValue => {
    const c = text[i];
    if (c === '"') return { kind: "string", value: readString() };
    if (text.startsWith("true", i)) {
      i += 4;
      return { kind: "boolean", value: true };
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return { kind: "boolean", value: false };
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return { kind: "null" };
    }
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (match) {
      i += match[0].length;
      return { kind: "number", text: match[0] };
    }
    return fail(c === undefined ? "Unexpected end of text" : "Unexpected character");
  };

  const attach = (value: JsonValue) => {
    const top = stack[stack.length - 1];
    if (!top) root = value;
    else if (top.node.kind === "array") top.node.items.push(value);
    else {
      top.node.entries.push({ key: (top as { key: string }).key, value });
      (top as { key: string | null }).key = null;
    }
  };

  for (;;) {
    // A value is next.
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const node: ObjectValue = { kind: "object", entries: [] };
      attach(node);
      const frame: Frame = { node, key: null };
      stack.push(frame);
      skip();
      if (text[i] !== "}") {
        readKey(frame);
        continue;
      }
      i++;
      stack.pop();
    } else if (c === "[") {
      i++;
      const node: ArrayValue = { kind: "array", items: [] };
      attach(node);
      stack.push({ node });
      skip();
      if (text[i] !== "]") continue;
      i++;
      stack.pop();
    } else {
      attach(readScalar());
    }

    // A value ended: its container closes, or goes on past a comma.
    for (;;) {
      skip();
      const top = stack[stack.length - 1];
      if (!top) {
        if (i < text.length) fail("Unexpected text after the value");
        return root as JsonValue;
      }
      const close = top.node.kind === "array" ? "]" : "}";
      if (text[i] === close) {
        i++;
        stack.pop();
        continue;
      }
      if (text[i] !== ",") fail(`Expected , or ${close}`);
      i++;
      skip();
      if (text[i] === close) {
        i++;
        stack.pop();
        continue;
      }
      if (top.node.kind === "object") readKey(top);
      break;
    }
  }
}

/** How many values are in `value`, itself included. */
export function countValues(value: JsonValue): number {
  let count = 0;
  const pending: JsonValue[] = [value];
  for (let next = pending.pop(); next; next = pending.pop()) {
    count++;
    if (next.kind === "object") for (const entry of next.entries) pending.push(entry.value);
    else if (next.kind === "array") for (const item of next.items) pending.push(item);
  }
  return count;
}

/** One line of the tree: a member of an object, or an item of an array. */
export interface JsonRow {
  /** Names the row's place in the tree, for what is open. */
  readonly path: string;
  readonly depth: number;
  /** The member's key, or the item's index; none for a lone root value. */
  readonly label: string | number | null;
  readonly value: JsonValue;
}

/** Whether `value` has members or items to open. */
export function hasChildren(value: JsonValue): boolean {
  return (
    (value.kind === "object" && value.entries.length > 0) ||
    (value.kind === "array" && value.items.length > 0)
  );
}

/**
 * The rows shown, in order: the root's members (a root that is no object
 * or array is one row of its own), and the members of each row that is
 * open, under it.
 */
export function visibleRows(
  root: JsonValue,
  isOpen: (path: string, depth: number) => boolean,
): JsonRow[] {
  const rows: JsonRow[] = [];
  if (!hasChildren(root)) {
    rows.push({ path: "", depth: 0, label: null, value: root });
    return rows;
  }
  // Each container being walked, and the next of its children.
  const stack: { value: JsonValue; path: string; depth: number; next: number }[] = [
    { value: root, path: "", depth: 0, next: 0 },
  ];
  while (stack.length > 0) {
    const level = stack[stack.length - 1] as (typeof stack)[number];
    const { value } = level;
    const index = level.next++;
    let label: string | number;
    let child: JsonValue | undefined;
    if (value.kind === "object") {
      const entry = value.entries[index];
      label = entry?.key ?? "";
      child = entry?.value;
    } else {
      label = index;
      child = value.kind === "array" ? value.items[index] : undefined;
    }
    if (child === undefined) {
      stack.pop();
      continue;
    }
    const path = `${level.path}\u0000${label}`;
    rows.push({ path, depth: level.depth, label, value: child });
    if (hasChildren(child) && isOpen(path, level.depth)) {
      stack.push({ value: child, path, depth: level.depth + 1, next: 0 });
    }
  }
  return rows;
}

/** How much of a long string its row shows; the raw view has all of it. */
export const ROW_STRING_CHARS = 1000;

/** Whether `text` has a control character, which would break a row's line. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x20) return true;
  return false;
}

/** A row's key or index as it shows: quoted when empty or holding a control character. */
export function labelText(label: string | number): string {
  if (typeof label === "number") return String(label);
  return label === "" || hasControl(label) ? JSON.stringify(label) : label;
}

/** The text a value shows; none for an object or array, which show a count. */
export function valueText(value: JsonValue): string | null {
  switch (value.kind) {
    case "object":
    case "array":
      return null;
    case "string": {
      const text = JSON.stringify(value.value);
      return text.length > ROW_STRING_CHARS ? `${text.slice(0, ROW_STRING_CHARS)}…` : text;
    }
    case "number":
      return value.text;
    case "null":
      return "null";
    default:
      return String(value.value);
  }
}

/** A match of a find in a row: in its key or its value, and where in that text. */
export interface TreeMatch {
  /** The row's place in the rows found in, and its path. */
  readonly row: number;
  readonly path: string;
  readonly part: "label" | "value";
  readonly start: number;
  readonly end: number;
}

/**
 * The matches of a find in `rows`' keys and values, as they show, in
 * order. `find` is given the text of them all, a NUL between each, and
 * returns [start, end] offsets one after another.
 */
export function treeMatches(
  rows: readonly JsonRow[],
  find: (text: string) => number[],
): TreeMatch[] {
  const pieces: string[] = [];
  const owners: { readonly row: number; readonly part: TreeMatch["part"] }[] = [];
  const starts: number[] = [];
  let length = 0;
  const add = (text: string, row: number, part: TreeMatch["part"]) => {
    pieces.push(text);
    owners.push({ row, part });
    starts.push(length);
    length += text.length + 1;
  };
  rows.forEach((row, index) => {
    if (row.label !== null) add(labelText(row.label), index, "label");
    const value = valueText(row.value);
    if (value !== null) add(value, index, "value");
  });
  const found = find(pieces.join("\u0000"));
  const matches: TreeMatch[] = [];
  let at = 0;
  for (let i = 0; i < found.length; i += 2) {
    const start = found[i] as number;
    // The matches come in order, so the piece each is in only moves on.
    while (at + 1 < starts.length && (starts[at + 1] as number) <= start) at++;
    const owner = owners[at];
    const offset = starts[at];
    const row = owner ? rows[owner.row] : undefined;
    if (!owner || !row || offset === undefined) break;
    matches.push({
      row: owner.row,
      path: row.path,
      part: owner.part,
      start: start - offset,
      end: (found[i + 1] as number) - offset,
    });
  }
  return matches;
}

/** The paths of the objects and arrays `path` is in, outermost first. */
export function ancestorPaths(path: string): string[] {
  const paths: string[] = [];
  for (let at = path.indexOf("\u0000", 1); at !== -1; at = path.indexOf("\u0000", at + 1)) {
    paths.push(path.slice(0, at));
  }
  return paths;
}
