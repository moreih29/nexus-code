export interface AxNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: readonly {
    readonly name: string;
    readonly value: { readonly value?: unknown };
  }[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

export interface SnapshotRef {
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
}

export interface Snapshot {
  readonly text: string;
  readonly refs: ReadonlyMap<string, SnapshotRef>;
  readonly omitted: number;
}

export interface SnapshotOptions {
  readonly maxLines: number;
  readonly within?: number;
}

const GROUPING_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "LabelText",
  "paragraph",
  "Section",
  "group",
]);

const PAGE_ROLES = new Set(["RootWebArea", "WebArea"]);

const SKIPPED_ROLES = new Set(["MenuListPopup", "InlineTextBox", "LineBreak"]);

const TEXT_ROLES = new Set(["StaticText", "text"]);

const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

const MAX_NAME = 200;

function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
}

export function roleAndName(node: AxNode): { role: string; name: string } {
  return {
    role: typeof node.role?.value === "string" ? node.role.value : "",
    name: clean(node.name?.value),
  };
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function marks(node: AxNode, role: string): string {
  const out: string[] = [];
  const level = property(node, "level");
  if (typeof level === "number") out.push(`level=${level}`);
  const checked = property(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  if (checked === "mixed") out.push("checked=mixed");
  const pressed = property(node, "pressed");
  if (pressed === "true" || pressed === true) out.push("pressed");
  if (property(node, "selected") === true) out.push("selected");
  if (property(node, "expanded") === true) out.push("expanded");
  if (property(node, "disabled") === true) out.push("disabled");
  if (property(node, "focused") === true) out.push("focused");
  if (property(node, "invalid") === "true") out.push("invalid");
  if (VALUE_ROLES.has(role)) {
    const value = clean(node.value?.value);
    if (value !== "") out.push(`value=${JSON.stringify(value)}`);
  }
  if (role === "link") {
    const url = property(node, "url");
    if (typeof url === "string" && url !== "") out.push(`url=${url}`);
  }
  return out.map((m) => ` [${m}]`).join("");
}

export function buildSnapshot(nodes: readonly AxNode[], options: SnapshotOptions): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = new Map<string, SnapshotRef>();
  const lines: string[] = [];
  let omitted = 0;
  let textLine: { index: number; depth: number } | null = null;

  const emit = (depth: number, line: string): boolean => {
    textLine = null;
    if (lines.length >= options.maxLines) {
      omitted += 1;
      return false;
    }
    lines.push(`${"  ".repeat(depth)}- ${line}`);
    return true;
  };

  const emitText = (depth: number, text: string): void => {
    if (textLine && textLine.depth === depth) {
      if (textLine.index >= 0) lines[textLine.index] += ` ${text}`;
      return;
    }
    const index = emit(depth, `text: ${text}`) ? lines.length - 1 : -1;
    textLine = { index, depth };
  };

  const walk = (node: AxNode, depth: number, parentName: string): void => {
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is AxNode => n !== undefined);
    const { role, name } = roleAndName(node);

    if (node.ignored || PAGE_ROLES.has(role) || (GROUPING_ROLES.has(role) && name === "")) {
      for (const child of children) walk(child, depth, parentName);
      return;
    }
    if (SKIPPED_ROLES.has(role)) return;
    if (TEXT_ROLES.has(role)) {
      if (name !== "" && name !== parentName) emitText(depth, name);
      return;
    }

    let line = role + (name === "" ? "" : ` ${JSON.stringify(name)}`) + marks(node, role);
    if (node.backendDOMNodeId !== undefined && lines.length < options.maxLines) {
      const ref = `e${refs.size + 1}`;
      refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
      line += ` [ref=${ref}]`;
    }
    emit(depth, line);
    if (FIELD_ROLES.has(role)) return;
    for (const child of children) walk(child, depth + 1, name);
  };

  const start =
    options.within === undefined
      ? nodes.find((n) => n.parentId === undefined)
      : nodes.find((n) => n.backendDOMNodeId === options.within);
  if (start) walk(start, 0, "");
  return { text: lines.join("\n"), refs, omitted };
}
