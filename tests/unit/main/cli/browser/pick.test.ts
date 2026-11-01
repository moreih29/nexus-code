/**
 * What nexus browser pick says of an element: the selector the page builds
 * for it, run here on a small stand-in for the DOM, and the block the
 * command prints.
 */
import { describe, expect, test } from "bun:test";
import {
  DESCRIBE_PICKED,
  formatPick,
  type PickedDetails,
  type PickedElement,
  pickedLabel,
} from "../../../../../src/main/features/cli/browser/pick";

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

  getRootNode(): FakeDocument {
    return this.doc;
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
    const unescaped = (s: string) => s.replace(/\\(.)/g, "$1");
    const tag = /^[a-z][\w-]*/.exec(step)?.[0];
    if (tag && tag !== this.localName) return false;
    for (const [, kind, value] of step.matchAll(/([#.])((?:\\.|[\w-])+)/g)) {
      const name = unescaped(value as string);
      if (kind === "#" && this.id !== name) return false;
      if (kind === "." && !this.className.split(/\s+/).includes(name)) return false;
    }
    for (const [, attr, value] of step.matchAll(/\[([\w-]+)=("(?:[^"\\]|\\.)*")\]/g)) {
      if (this.getAttribute(attr as string) !== JSON.parse(value as string)) return false;
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
  expect(built.doc.querySelectorAll(selector)).toEqual([el]);
  return selector;
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
});

describe("the picked element's text, HTML and box", () => {
  test("collapses white space, cuts long HTML after the open tag, and clips in page coordinates", () => {
    const built = page(["div", { key: "box", id: "box", class: "card" }]);
    const el = built.at.box as FakeElement;
    el.innerText = "  Hello\n   world  ";
    el.outerHTML = `<div id="box" class="card">${"<i>x</i>".repeat(100)}</div>`;
    const details = describeIn(built.doc, el);
    expect(details).toMatchObject({
      tag: "div",
      text: "Hello world",
      html: '<div id="box" class="card">…</div>',
      inShadow: false,
      box: { x: 10, y: 20, width: 80, height: 24 },
      // 8 px around it, moved down by the page's scroll of 300.
      clip: { x: 2, y: 312, width: 96, height: 40 },
    });
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
  test("names the element by its tag when its role says nothing", () => {
    expect(pickedLabel({ role: "generic", name: "", tag: "span" })).toBe("span");
    expect(pickedLabel({ role: "", name: "Total", tag: "div" })).toBe('div "Total"');
    expect(pickedLabel({ role: "link", name: "Docs", tag: "a" })).toBe('link "Docs"');
  });

  test("gives the text only when the name does not, and marks a shadow root", () => {
    expect(formatPick(PICKED)).toBe(
      "[element] http://localhost:5173/\n" +
        '  button "Save" (ref e3)\n' +
        "  selector: #save\n" +
        "  box: 80x24 at (10, 20)\n" +
        '  html: <button id="save">Save</button>',
    );
    const inShadow = formatPick(
      { ...PICKED, role: "generic", name: "", text: "Total: 3", inShadow: true },
      "/tmp/a.png",
    );
    expect(inShadow).toContain("\n  button (ref e3)\n");
    expect(inShadow).toContain("selector: #save (inside a shadow root)");
    expect(inShadow).toContain('  text: "Total: 3"');
    expect(inShadow.endsWith("  screenshot: /tmp/a.png")).toBe(true);
  });
});
