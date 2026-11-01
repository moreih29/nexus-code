/**
 * An element the user picks in a browser tab, for nexus browser pick: where
 * it is, a CSS selector that finds it again, and the block an agent reads.
 */

/** A box in CSS pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the page tells of the picked element (DESCRIBE_PICKED). */
export interface PickedDetails {
  readonly tag: string;
  /**
   * Matches it alone in its document. Null for an element in a shadow root,
   * which no document selector reaches, or when no selector finds it alone.
   */
  readonly selector: string | null;
  readonly inShadow: boolean;
  readonly text: string;
  readonly html: string;
  /** Where it is in the tab, from the top left of what the tab shows. */
  readonly box: Box;
  /** The part of the page a picture of it takes, in page coordinates; null when none of it shows. */
  readonly clip: Box | null;
}

export interface PickedElement extends PickedDetails {
  readonly url: string;
  readonly title: string;
  /** Its role and name in the accessibility tree, as browser snapshot prints them. */
  readonly role: string;
  readonly name: string;
  /** The ref browser click, fill and type take for it. */
  readonly ref: string;
  /** A PNG of it, base64; absent when none could be taken. */
  readonly png?: string;
}

/** Why no element was picked. */
export type PickCancel =
  | "escape"
  | "timeout"
  | "hidden"
  | "navigated"
  | "closed"
  | "aborted"
  | "replaced";

export type PickResult = { readonly picked: PickedElement } | { readonly cancelled: PickCancel };

/** Room left around the element in its picture. */
const PICTURE_MARGIN = 8;
const MAX_TEXT = 200;
const MAX_HTML = 300;

/**
 * Runs in the page on the picked element. The selector is the element's own
 * id, test id, aria-label or name when that finds it alone, or else a path
 * of child steps up to the nearest ancestor that has one, or as far up as
 * it takes to find only the element. An element in a shadow root gets none,
 * as browser click looks selectors up in the document.
 */
export const DESCRIBE_PICKED = `function () {
  const el = this;
  const inShadow = el.getRootNode() !== document;
  const hex = (c) => "\\\\" + c.codePointAt(0).toString(16) + " ";
  const leadingDigit = (c, i, all) => /[0-9]/.test(c) && (i === 0 || (i === 1 && all[0] === "-"));
  const esc = (s) => globalThis.CSS && CSS.escape
    ? CSS.escape(s)
    : [...String(s)].map((c, i, all) => /[\\w-]/.test(c) && !leadingDigit(c, i, all) ? c : hex(c)).join("");
  const str = (s) => '"' + String(s).replace(/[\\\\"]/g, (c) => "\\\\" + c).replace(/[\\x00-\\x1f\\x7f]/g, hex) + '"';
  const only = (sel) => {
    try {
      const all = document.querySelectorAll(sel);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };
  const cut = (s, max) => s.length > max ? s.slice(0, max - 1) + "…" : s;
  const named = (node, rest) => {
    const tail = rest ? " > " + rest : "";
    const candidates = [];
    if (node.id) candidates.push("#" + esc(node.id));
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const value = node.getAttribute(attr);
      if (value) candidates.push("[" + attr + "=" + str(value) + "]");
    }
    for (const attr of ["aria-label", "name"]) {
      const value = node.getAttribute(attr);
      if (value) candidates.push(node.localName + "[" + attr + "=" + str(value) + "]");
    }
    return candidates.find((sel) => only(sel + tail)) ?? "";
  };
  const step = (node) => {
    const classes = typeof node.className === "string"
      ? node.className.trim().split(/\\s+/).filter((c) => /^-?[A-Za-z_][\\w-]*$/.test(c)).slice(0, 2)
      : [];
    const sel = node.localName + classes.map((c) => "." + esc(c)).join("");
    const siblings = node.parentNode && node.parentNode.children ? [...node.parentNode.children] : [node];
    if (siblings.filter((c) => c.matches(sel)).length < 2) return sel;
    const sameTag = siblings.filter((c) => c.localName === node.localName);
    return sel + ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
  };
  let selector = null;
  if (!inShadow) {
    let path = "";
    for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
      const own = named(node, path);
      path = own ? own + (path ? " > " + path : "") : step(node) + (path ? " > " + path : "");
      if (only(path)) {
        selector = path;
        break;
      }
    }
  }
  const outer = el.outerHTML.replace(/\\s+/g, " ").trim();
  let html = outer;
  if (outer.length > ${MAX_HTML}) {
    const open = cut(outer.slice(0, outer.indexOf(">") + 1), ${MAX_HTML - 20});
    const close = "</" + el.localName + ">";
    html = open + "…" + (outer.endsWith(close) ? close : "");
  }
  const r = el.getBoundingClientRect();
  const left = Math.max(0, r.left - ${PICTURE_MARGIN});
  const top = Math.max(0, r.top - ${PICTURE_MARGIN});
  const right = Math.min(innerWidth, r.right + ${PICTURE_MARGIN});
  const bottom = Math.min(innerHeight, r.bottom + ${PICTURE_MARGIN});
  return {
    tag: el.localName,
    selector,
    inShadow,
    text: cut((el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim(), ${MAX_TEXT}),
    html,
    box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    clip: right - left >= 1 && bottom - top >= 1
      ? { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top }
      : null,
  };
}`;

/**
 * `s` without control characters but line breaks and tabs: a page's text,
 * printed to a terminal, must not carry escape sequences into it.
 */
export function withoutControls(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** `el` with every text the page gave it free of control characters. */
export function cleanPicked(el: PickedElement): PickedElement {
  return {
    ...el,
    url: withoutControls(el.url),
    title: withoutControls(el.title),
    tag: withoutControls(el.tag),
    role: withoutControls(el.role),
    name: withoutControls(el.name),
    selector: el.selector === null ? null : withoutControls(el.selector),
    text: withoutControls(el.text),
    html: withoutControls(el.html),
  };
}

/** Roles that say nothing of an element; its tag says more. */
const VAGUE_ROLES = new Set(["", "generic", "none", "presentation"]);

/** How output names the element: `button "Sign in"`, or its tag when its role says nothing. */
export function pickedLabel(el: Pick<PickedElement, "role" | "name" | "tag">): string {
  const what = VAGUE_ROLES.has(el.role) ? el.tag : el.role;
  return el.name === "" ? what : `${what} ${JSON.stringify(el.name)}`;
}

/**
 * The block nexus browser pick prints; `screenshot` is where its picture was
 * saved. `tab` names the browser tab, for a reader who did not pick it.
 */
export function formatPick(picked: PickedElement, screenshot?: string, tab?: string): string {
  const el = cleanPicked(picked);
  const lines = [
    tab === undefined ? `[element] ${el.url}` : `[element in browser tab ${tab}] ${el.url}`,
    `  ${pickedLabel(el)} (ref ${el.ref})`,
    `  selector: ${selectorText(el)}`,
    `  box: ${el.box.width}x${el.box.height} at (${el.box.x}, ${el.box.y})`,
  ];
  if (el.text !== "" && el.text !== el.name) lines.push(`  text: ${JSON.stringify(el.text)}`);
  lines.push(`  html: ${el.html}`);
  if (screenshot !== undefined) lines.push(`  screenshot: ${screenshot}`);
  return withoutControls(lines.join("\n"));
}

function selectorText(el: PickedElement): string {
  if (el.selector !== null) return el.selector;
  return el.inShadow ? "none, as it is inside a shadow root; use the ref" : "none found; use the ref";
}

/** Why a pick ended without an element, said for the agent. */
export function cancelledText(reason: Exclude<PickCancel, "timeout">): string {
  switch (reason) {
    case "escape":
      return "the user cancelled the pick with Esc";
    case "hidden":
      return "the browser tab was hidden before an element was picked";
    case "navigated":
      return "the page went to another page before an element was picked";
    case "closed":
      return "the browser tab closed before an element was picked";
    case "replaced":
      return "another pick started in this browser tab";
    case "aborted":
      return "the pick was stopped";
  }
}
