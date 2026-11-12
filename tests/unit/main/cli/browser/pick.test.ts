/**
 * What nexus browser pick says of an element: the selector the page builds
 * for it, run here on a small stand-in for the DOM, and the block the
 * command prints.
 */
import { describe, expect, test } from "bun:test";
import {
  cleanPicked,
  DESCRIBE_PICKED,
  formatPick,
  type PickedDetails,
  type PickedElement,
  withoutControls,
} from "../../../../../src/main/features/cli/browser/pick";

/** A CSS escape or string body read back: \\hex (and one space after it), or \\char. */
function cssUnescape(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, ch: string) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ch,
  );
}

/**
 * Just enough of an element for DESCRIBE_PICKED, with a matcher for the
 * selectors it writes: tags, #id, .class, [attr="value"], :nth-of-type(n)
 * and " > ".
 */
class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | FakeDocument | null = null;
  readonly children: FakeElement[] = [];
  outerHTML = "";
  innerText = "";
  /** The shadow root it is in, when it is in one. */
  shadowRoot: object | null = null;

  constructor(
    readonly localName: string,
    private readonly attrs: Record<string, string>,
    readonly doc: FakeDocument,
  ) {}

  get id(): string {
    return this.attrs.id ?? "";
  }

  get className(): string {
    return this.attrs.class ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getRootNode(): object {
    return this.shadowRoot ?? this.doc;
  }

  getBoundingClientRect() {
    return { left: 10, top: 20, right: 90, bottom: 44, width: 80, height: 24 };
  }

  matches(selector: string): boolean {
    const steps = selector.split(" > ");
    let el: FakeElement | null = this;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (!el?.matchesStep(steps[i] as string)) return false;
      el = el.parentNode instanceof FakeElement ? el.parentNode : null;
    }
    return true;
  }

  private matchesStep(step: string): boolean {
    const tag = /^[a-z][\w-]*/.exec(step)?.[0];
    if (tag && tag !== this.localName) return false;
    const outside = step.replace(/\[[^\]]*\]/g, "");
    for (const [, kind, value] of outside.matchAll(
      /([#.])((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/g,
    )) {
      const name = cssUnescape(value as string);
      if (kind === "#" && this.id !== name) return false;
      if (kind === "." && !this.className.split(/\s+/).includes(name)) return false;
    }
    for (const [, attr, value] of step.matchAll(/\[([\w-]+)="((?:[^"\\]|\\.)*)"\]/g)) {
      if (this.getAttribute(attr as string) !== cssUnescape(value as string)) return false;
    }
    const nth = /:nth-of-type\((\d+)\)/.exec(step)?.[1];
    if (nth) {
      const same = (this.parentNode?.children ?? []).filter((c) => c.localName === this.localName);
      if (same.indexOf(this) + 1 !== Number(nth)) return false;
    }
    return true;
  }
}

class FakeDocument {
  readonly nodeType = 9;
  readonly children: FakeElement[] = [];

  querySelectorAll(selector: string): FakeElement[] {
    const all: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      all.push(el);
      el.children.forEach(walk);
    };
    this.children.forEach(walk);
    return all.filter((el) => el.matches(selector));
  }
}

type Spec = [tag: string, attrs?: Record<string, string>, ...children: Spec[]];

/** A document of `body`'s children; returns it with its elements by their "key" attribute. */
function page(...body: Spec[]): { doc: FakeDocument; at: Record<string, FakeElement> } {
  const doc = new FakeDocument();
  const at: Record<string, FakeElement> = {};
  const build = (spec: Spec, parent: FakeElement | FakeDocument): FakeElement => {
    const [tag, attrs = {}, ...kids] = spec;
    const { key, ...rest } = attrs;
    const el = new FakeElement(tag, rest, doc);
    el.parentNode = parent;
    parent.children.push(el);
    if (key) at[key] = el;
    for (const kid of kids) build(kid, el);
    return el;
  };
  build(["html", {}, ["body", {}, ...body]], doc);
  return { doc, at };
}

function describeIn(doc: FakeDocument, el: FakeElement): PickedDetails {
  const fn = new Function(
    "document",
    "innerWidth",
    "innerHeight",
    "scrollX",
    "scrollY",
    `return (${DESCRIBE_PICKED});`,
  )(doc, 1280, 800, 0, 300) as (this: FakeElement) => PickedDetails;
  return fn.call(el);
}

/** The selector built for `key`, after checking that it finds that element alone. */
function selectorOf(built: ReturnType<typeof page>, key: string): string {
  const el = built.at[key] as FakeElement;
  const { selector } = describeIn(built.doc, el);
  expect(selector).not.toBeNull();
  expect(built.doc.querySelectorAll(selector as string)).toEqual([el]);
  return selector as string;
}

describe("the picked element's selector", () => {
  test("is its id or test id when that is unique", () => {
    const built = page([
      "form",
      { key: "form", id: "login" },
      ["button", { key: "button", "data-testid": "submit" }],
    ]);
    expect(selectorOf(built, "form")).toBe("#login");
    expect(selectorOf(built, "button")).toBe('[data-testid="submit"]');
  });

  test("names it by aria-label or name when unique", () => {
    const built = page(
      ["nav", {}, ["button", { key: "close", "aria-label": "Close" }], ["button", {}]],
      ["input", { key: "q", name: "q" }],
    );
    expect(selectorOf(built, "close")).toBe('button[aria-label="Close"]');
    expect(selectorOf(built, "q")).toBe('input[name="q"]');
  });

  test("steps down from the nearest named ancestor, numbering siblings alike", () => {
    const built = page(
      ["ul", {}, ["li", { class: "item" }], ["li", { class: "item" }]],
      [
        "ul",
        { id: "list" },
        ["li", { class: "item" }],
        ["li", { key: "second", class: "item" }],
        ["li", { class: "item" }],
      ],
    );
    expect(selectorOf(built, "second")).toBe("#list > li.item:nth-of-type(2)");
  });

  test("stops climbing once the path matches only the element", () => {
    const built = page([
      "main",
      {},
      ["section", {}, ["p", { key: "lead", class: "lead" }], ["p", {}]],
    ]);
    expect(selectorOf(built, "lead")).toBe("p.lead");
  });

  test("passes over an id two elements share and classes a selector cannot spell plainly", () => {
    const built = page(
      ["div", { id: "dup" }, ["span", { key: "a", class: "hover:bg-red x" }]],
      ["div", { id: "dup" }, ["span", { class: "x" }]],
    );
    const selector = selectorOf(built, "a");
    expect(selector).not.toContain("#dup");
    expect(selector).not.toContain("hover");
    expect(selector).toBe("div:nth-of-type(1) > span.x");
  });

  test("escapes attribute values as CSS, so a control character cannot match another element", () => {
    // JSON would write \u0001, which CSS reads as the letter u: "xu0001y".
    const built = page(
      ["button", { "data-testid": "xu0001y" }],
      ["button", { key: "odd", "data-testid": 'x\u0001y"z' }],
    );
    expect(selectorOf(built, "odd")).toBe('[data-testid="x\\1 y\\"z"]');
  });

  test("escapes an id that starts with a digit or holds odd characters", () => {
    const built = page(["div", { key: "a", id: "1a b" }], ["div", { id: "other" }]);
    expect(selectorOf(built, "a")).toBe("#\\31 a\\20 b");
  });

  test("is none for an element in a shadow root, which a document selector cannot reach", () => {
    const built = page(["div", {}, ["button", { key: "inner", id: "go" }]]);
    const el = built.at.inner as FakeElement;
    el.shadowRoot = {};
    const details = describeIn(built.doc, el);
    expect(details.selector).toBeNull();
    expect(details.inShadow).toBe(true);
  });
});

const PICKED: PickedElement = {
  url: "http://localhost:5173/",
  title: "App",
  tag: "button",
  role: "button",
  name: "Save",
  ref: "e3",
  selector: "#save",
  inShadow: false,
  text: "Save",
  html: '<button id="save">Save</button>',
  box: { x: 10, y: 20, width: 80, height: 24 },
  clip: null,
};

describe("the printed block", () => {
  test("carries no control characters from the page to the terminal", () => {
    const hostile = {
      ...PICKED,
      title: "T\u009b2J",
      name: "Save\u001b]0;pwned\u0007",
      text: "a\u0003b",
      html: '<button title="\u001b[201~">Save</button>',
    };
    const block = formatPick(hostile);
    expect(block).toBe(withoutControls(block));
    expect(block).not.toContain("\u001b");
    expect(block).toContain('button "Save]0;pwned" (ref e3)');
    expect(block).toContain('<button title="[201~">Save</button>');
    const clean = cleanPicked(hostile);
    expect(clean.title).toBe("T2J");
    expect(clean.text).toBe("ab");
    expect(JSON.stringify(clean)).not.toMatch(/[\u0080-\u009f]|\\u001b/);
    expect(withoutControls("a\n\tb\r\u0000")).toBe("a\n\tb");
  });
});
