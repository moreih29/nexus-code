// Find in the text a preview draws: the Markdown, notebook, DOCX and PPTX
// previews, and, run inside its own document, the HTML preview's.
//
// The text nodes under the root, those in open shadow roots too, are read
// in order into one string, a NUL between blocks so that no match runs
// from one paragraph or cell into the next. The matches are painted with
// the CSS Custom Highlight API, which leaves the DOM as it is: nothing the
// preview drew, or its scripts hold, changes. The current one is scrolled
// to the middle of every box it scrolls in. A change to the DOM finds
// again, keeping to the same match as near as it can.
//
// createDomFinder is self-contained, its helpers inside it, so the HTML
// preview can run it in its sandboxed document from its source; the
// matching it is handed (find-matches.ts) is too.

/** How many matches a find goes up to. */
export const MAX_FIND_MATCHES = 10000;

/** The background of every match, and of the current one. */
export const FIND_COLORS = {
  match: "rgba(255, 210, 0, 0.4)",
  current: "rgba(255, 140, 0, 0.85)",
} as const;

export interface DomFinder {
  search(query: string, caseSensitive: boolean): void;
  move(direction: 1 | -1): void;
  clear(): void;
}

/**
 * A finder for the text under `getRoot()`. Its matches are painted as the
 * highlights `name` and `name`-current, in `colors`; `report` is told how
 * many there are, and which is current (from 1, or 0 for none).
 */
export function createDomFinder(
  getRoot: () => Node | null,
  findMatches: (text: string, query: string, caseSensitive: boolean, limit: number) => number[],
  limit: number,
  name: string,
  colors: { readonly match: string; readonly current: string },
  report: (total: number, current: number) => void,
): DomFinder {
  const BLOCK =
    /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|CAPTION|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|IMG|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/i;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|TEXTAREA|SELECT)$/i;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `::highlight(${name}) { background-color: ${colors.match}; }\n` +
      `::highlight(${name}-current) { background-color: ${colors.current}; }`,
  );
  const adopted = new Set<Document | ShadowRoot>();
  let ranges: Range[] = [];
  let current = -1;
  let query = "";
  let caseSensitive = false;
  let observer: MutationObserver | null = null;
  let observed = new Set<Node>();
  let again: ReturnType<typeof setTimeout> | undefined;

  function adopt(scope: Document | ShadowRoot): void {
    if (adopted.has(scope)) return;
    adopted.add(scope);
    scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
  }

  /** The text under the root, and where each of its nodes starts in it. */
  function read(root: Node): { text: string; nodes: Text[]; starts: number[]; scopes: Node[] } {
    const nodes: Text[] = [];
    const starts: number[] = [];
    const scopes: Node[] = [root];
    const shown = new Map<Element, boolean>();
    let text = "";
    let broken = true;
    const visible = (el: Element | null): boolean => {
      if (!el) return true;
      let seen = shown.get(el);
      if (seen === undefined) {
        seen = typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
        shown.set(el, seen);
      }
      return seen;
    };
    const walk = (parent: Node): void => {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const node = child as Text;
          if (!node.data || !visible(node.parentElement)) continue;
          starts.push(text.length);
          nodes.push(node);
          text += node.data;
          broken = false;
        } else if (child.nodeType === 1) {
          const el = child as Element;
          if (SKIP.test(el.tagName)) continue;
          const block = BLOCK.test(el.tagName);
          if (block && !broken) {
            text += "\u0000";
            broken = true;
          }
          if (el.shadowRoot) {
            adopt(el.shadowRoot);
            scopes.push(el.shadowRoot);
            walk(el.shadowRoot);
          }
          walk(el);
          if (block && !broken) {
            text += "\u0000";
            broken = true;
          }
        }
      }
    };
    walk(root);
    return { text, nodes, starts, scopes };
  }

  /** The node holding offset `at` of the text, and the offset in it. */
  function locate(nodes: Text[], starts: number[], at: number, end: boolean): [Text, number] {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      const start = starts[mid] as number;
      if (start < at || (!end && start === at)) low = mid;
      else high = mid - 1;
    }
    const node = nodes[low] as Text;
    return [node, Math.min(node.data.length, at - (starts[low] as number))];
  }

  function paint(): void {
    const registry = CSS.highlights;
    if (ranges.length === 0) {
      registry.delete(name);
      registry.delete(`${name}-current`);
      return;
    }
    registry.set(name, new Highlight(...ranges));
    const focused = ranges[current];
    if (focused) {
      const highlight = new Highlight(focused);
      highlight.priority = 1;
      registry.set(`${name}-current`, highlight);
    } else {
      registry.delete(`${name}-current`);
    }
  }

  /** Scrolls `range` to the middle of each box it scrolls in, inner first. */
  function reveal(range: Range): void {
    let el: Element | null = range.startContainer.parentElement;
    while (el) {
      const doc = el.ownerDocument;
      const style = doc.defaultView?.getComputedStyle(el);
      const page = el === doc.scrollingElement;
      const scrollsY =
        page || (/(auto|scroll)/.test(style?.overflowY ?? "") && el.scrollHeight > el.clientHeight);
      const scrollsX =
        page || (/(auto|scroll)/.test(style?.overflowX ?? "") && el.scrollWidth > el.clientWidth);
      if (scrollsY || scrollsX) {
        const box = page
          ? {
              top: 0,
              left: 0,
              bottom: doc.defaultView?.innerHeight ?? 0,
              right: doc.defaultView?.innerWidth ?? 0,
            }
          : el.getBoundingClientRect();
        const at = range.getBoundingClientRect();
        if (scrollsY && (at.top < box.top || at.bottom > box.bottom)) {
          el.scrollTop += at.top - box.top - (box.bottom - box.top - at.height) / 2;
        }
        if (scrollsX && (at.left < box.left || at.right > box.right)) {
          el.scrollLeft += at.left - box.left - (box.right - box.left - at.width) / 2;
        }
      }
      const parent: Element | null = el.parentElement;
      el = parent ?? ((el.getRootNode() as ShadowRoot).host || null);
    }
  }

  function watch(scopes: Node[]): void {
    const next = new Set(scopes);
    const same = next.size === observed.size && scopes.every((scope) => observed.has(scope));
    if (same && observer) return;
    observer?.disconnect();
    observed = next;
    observer = new MutationObserver(() => {
      clearTimeout(again);
      again = setTimeout(() => run(false), 200);
    });
    for (const scope of scopes) {
      observer.observe(scope, { childList: true, subtree: true, characterData: true });
    }
  }

  /** Finds again; a new query starts at the first match in view. */
  function run(fresh: boolean): void {
    const root = getRoot();
    const before = ranges[current];
    ranges = [];
    current = -1;
    if (!root || !query.trim()) {
      paint();
      report(0, 0);
      return;
    }
    const doc = root.ownerDocument ?? (root as Document);
    adopt(doc);
    const { text, nodes, starts, scopes } = read(root);
    watch(scopes);
    const found = findMatches(text, query, caseSensitive, limit);
    for (let i = 0; i < found.length; i += 2) {
      const range = doc.createRange();
      const [startNode, startOffset] = locate(nodes, starts, found[i] as number, false);
      const [endNode, endOffset] = locate(nodes, starts, found[i + 1] as number, true);
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      ranges.push(range);
    }
    if (ranges.length > 0) {
      if (fresh) {
        const top =
          root.nodeType === 1
            ? (root as Element).getBoundingClientRect().top
            : Number.NEGATIVE_INFINITY;
        current = ranges.findIndex((range) => range.getBoundingClientRect().bottom > top);
        if (current === -1) current = 0;
      } else {
        // The match that was current, or the one now where it was.
        const at = before ? before.getBoundingClientRect() : null;
        current = at
          ? Math.max(
              0,
              ranges.findIndex((range) => range.getBoundingClientRect().top >= at.top - 1),
            )
          : 0;
      }
    }
    paint();
    const focused = ranges[current];
    if (focused && fresh) reveal(focused);
    report(ranges.length, current + 1);
  }

  return {
    search(nextQuery: string, nextCaseSensitive: boolean): void {
      query = nextQuery;
      caseSensitive = nextCaseSensitive;
      clearTimeout(again);
      run(true);
    },
    move(direction: 1 | -1): void {
      if (ranges.length === 0) return;
      current = (current + direction + ranges.length) % ranges.length;
      paint();
      const focused = ranges[current];
      if (focused) reveal(focused);
      report(ranges.length, current + 1);
    },
    clear(): void {
      query = "";
      clearTimeout(again);
      observer?.disconnect();
      observer = null;
      observed = new Set();
      ranges = [];
      current = -1;
      paint();
    },
  };
}
