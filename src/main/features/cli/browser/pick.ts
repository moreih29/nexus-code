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
  /** Matches it alone in its document, or in its shadow root when it is in one. */
  readonly selector: string;
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
 * id, test id, aria-label or name when that is unique, or else a path of
 * child steps up to the nearest ancestor that has one, or as far up as it
 * takes to match only the element.
 */
export const DESCRIBE_PICKED = `function () {
  const el = this;
  const scope = el.getRootNode();
  const esc = (s) => globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, (c) => "\\\\" + c);
  const count = (sel) => { try { return scope.querySelectorAll(sel).length; } catch { return 0; } };
  const cut = (s, max) => s.length > max ? s.slice(0, max - 1) + "…" : s;
  const named = (node) => {
    if (node.id && count("#" + esc(node.id)) === 1) return "#" + esc(node.id);
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const value = node.getAttribute(attr);
      const sel = "[" + attr + "=" + JSON.stringify(value) + "]";
      if (value && count(sel) === 1) return sel;
    }
    for (const attr of ["aria-label", "name"]) {
      const value = node.getAttribute(attr);
      const sel = node.localName + "[" + attr + "=" + JSON.stringify(value) + "]";
      if (value && count(sel) === 1) return sel;
    }
    return "";
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
  let selector = "";
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const own = named(node);
    selector = (own || step(node)) + (selector ? " > " + selector : "");
    if (own || count(selector) === 1) break;
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
    inShadow: scope !== document,
    text: cut((el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim(), ${MAX_TEXT}),
    html,
    box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    clip: right - left >= 1 && bottom - top >= 1
      ? { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top }
      : null,
  };
}`;

/** Roles that say nothing of an element; its tag says more. */
const VAGUE_ROLES = new Set(["", "generic", "none", "presentation"]);

/** How output names the element: `button "Sign in"`, or its tag when its role says nothing. */
export function pickedLabel(el: Pick<PickedElement, "role" | "name" | "tag">): string {
  const what = VAGUE_ROLES.has(el.role) ? el.tag : el.role;
  return el.name === "" ? what : `${what} ${JSON.stringify(el.name)}`;
}

/** The block nexus browser pick prints; `screenshot` is where its picture was saved. */
export function formatPick(el: PickedElement, screenshot?: string): string {
  const lines = [
    `[element] ${el.url}`,
    `  ${pickedLabel(el)} (ref ${el.ref})`,
    `  selector: ${el.selector}${el.inShadow ? " (inside a shadow root)" : ""}`,
    `  box: ${el.box.width}x${el.box.height} at (${el.box.x}, ${el.box.y})`,
  ];
  if (el.text !== "" && el.text !== el.name) lines.push(`  text: ${JSON.stringify(el.text)}`);
  lines.push(`  html: ${el.html}`);
  if (screenshot !== undefined) lines.push(`  screenshot: ${screenshot}`);
  return lines.join("\n");
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
