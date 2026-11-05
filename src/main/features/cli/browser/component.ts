/**
 * The UI component an element of a page belongs to, for nexus browser pick
 * and inspect: what a framework's development build leaves on the DOM
 * node tells it, and where in the source the element is written.
 *
 * React (16 to 19) keeps its fiber on the node; Vue 3 its component
 * instance, Vue 2 its view model on a component's root element; Svelte
 * (dev) the place in the file that wrote the element; Angular (dev) gives
 * the component through its `ng` global. A production build keeps less:
 * names are minified, and no source is left.
 */

/** The component an element is in. */
export interface PickedComponent {
  readonly framework: "React" | "Vue" | "Svelte" | "Angular";
  /** The component the element is in, and those it is in, innermost first. */
  readonly names: readonly string[];
  /**
   * Where the element is written: a file, and its line and column when the
   * framework tells them in the source's own terms.
   */
  readonly source?: string;
  /** The innermost component's props, each value shortened. */
  readonly props?: Readonly<Record<string, string>>;
}

/** How many components up the chain names. */
const MAX_NAMES = 6;
/** How many props are shown. */
const MAX_PROPS = 8;
/** How long a prop's value is shown. */
const MAX_PROP_CHARS = 60;

/**
 * Runs in the page on the element (`this`). Returns a PickedComponent, or
 * null when no framework it knows made the element. Reads only: no getter
 * that could run page code is called, but for Vue's props, whose values
 * are plain reactive reads.
 */
export const DESCRIBE_COMPONENT = `function () {
  const el = this;
  const own = (obj, key) => {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      return d && "value" in d ? d.value : undefined;
    } catch {
      return undefined;
    }
  };
  const keyStarting = (obj, prefix) => {
    try {
      return Object.keys(obj).find((k) => k.startsWith(prefix));
    } catch {
      return undefined;
    }
  };
  const short = (value) => {
    const cut = (s) => s.length > ${MAX_PROP_CHARS} ? s.slice(0, ${MAX_PROP_CHARS - 1}) + "…" : s;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return cut(JSON.stringify(value));
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (typeof value === "function") return "ƒ " + (value.name || "");
    if (typeof value === "symbol") return String(value);
    if (Array.isArray(value)) return "[" + value.length + " items]";
    if (typeof value === "object" && typeof value.$$typeof === "symbol") return "<element>";
    return "{…}";
  };
  const propsOf = (props, skip) => {
    if (!props || typeof props !== "object") return undefined;
    const out = {};
    let n = 0;
    let keys = [];
    try {
      keys = Object.keys(props);
    } catch {
      return undefined;
    }
    for (const key of keys) {
      if (skip.includes(key)) continue;
      if (n++ >= ${MAX_PROPS}) break;
      let value;
      try {
        value = props[key];
      } catch {
        value = undefined;
      }
      out[key] = short(value);
    }
    return n > 0 ? out : undefined;
  };
  const baseName = (file) => String(file).split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, "");
  /** A file named in a stack frame or a URL, as its path: no origin, no query. */
  const pathOf = (url) => {
    let path = String(url).replace(/^webpack-internal:\\/\\/\\/(?:\\([^)]*\\)\\/)?/, "");
    path = path.replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^/]*/i, "");
    return path.replace(/[?#].*$/, "");
  };

  const react = () => {
    const key = keyStarting(el, "__reactFiber$") ?? keyStarting(el, "__reactInternalInstance$");
    if (!key) return null;
    const host = own(el, key);
    if (!host || typeof host !== "object") return null;
    const nameOf = (type) => {
      if (typeof type === "function") return type.displayName || type.name || "";
      if (!type || typeof type !== "object") return "";
      if (typeof type.displayName === "string" && type.displayName) return type.displayName;
      if (typeof type.render === "function") return nameOf(type.render);
      if (type.type) return nameOf(type.type);
      return "";
    };
    const names = [];
    let inner = null;
    for (let f = host.return; f && names.length < ${MAX_NAMES}; f = f.return) {
      const name = nameOf(f.type);
      if (!name) continue;
      names.push(name);
      if (!inner) inner = f;
    }
    if (names.length === 0) return null;
    let source;
    const at = host._debugSource;
    if (at && at.fileName) {
      source = at.fileName + (at.lineNumber ? ":" + at.lineNumber + (at.columnNumber ? ":" + at.columnNumber : "") : "");
    } else if (host._debugStack && typeof host._debugStack.stack === "string") {
      // React 19 keeps where the element was made as a stack; its lines are
      // those of the code the browser ran, not of the source, so only the
      // file is told.
      // The first frame is React's own, where the stack was taken.
      const files = host._debugStack.stack
        .split("\\n")
        .map((line) => /\\(?((?:[a-z][a-z0-9+.-]*:\\/\\/|\\/)[^\\s()]*?):\\d+:\\d+\\)?\\s*$/i.exec(line))
        .filter(Boolean)
        .slice(1)
        .map((m) => pathOf(m[1]));
      source = files.find((file) => !/\\/node_modules\\/|\\/\\.vite\\/deps\\//.test(file));
    }
    const props = inner ? propsOf(inner.memoizedProps, ["children"]) : undefined;
    return { framework: "React", names, ...(source ? { source } : {}), ...(props ? { props } : {}) };
  };

  const vue3 = () => {
    const instance = own(el, "__vueParentComponent");
    if (!instance || typeof instance !== "object") return null;
    const nameOf = (i) => {
      const type = i.type || {};
      return type.__name || type.name || (type.__file ? baseName(type.__file) : "");
    };
    const names = [];
    for (let i = instance; i && names.length < ${MAX_NAMES}; i = i.parent) {
      const name = nameOf(i);
      if (name) names.push(name);
    }
    if (names.length === 0) return null;
    const file = instance.type && instance.type.__file;
    const props = propsOf(instance.props, []);
    return { framework: "Vue", names, ...(file ? { source: String(file) } : {}), ...(props ? { props } : {}) };
  };

  const vue2 = () => {
    let vm;
    for (let node = el; node && !vm; node = node.parentNode) vm = own(node, "__vue__");
    if (!vm || typeof vm !== "object") return null;
    const names = [];
    for (let v = vm; v && names.length < ${MAX_NAMES}; v = v.$parent) {
      const o = v.$options || {};
      const name = o.name || o._componentTag || (o.__file ? baseName(o.__file) : "");
      if (name) names.push(name);
    }
    if (names.length === 0) return null;
    const file = vm.$options && vm.$options.__file;
    const props = propsOf(vm.$props, []);
    return { framework: "Vue", names, ...(file ? { source: String(file) } : {}), ...(props ? { props } : {}) };
  };

  const svelte = () => {
    let meta;
    for (let node = el; node && !meta; node = node.parentNode) meta = own(node, "__svelte_meta");
    const loc = meta && meta.loc;
    if (!loc) return null;
    const file = Array.isArray(loc) ? loc[0] : loc.file;
    if (!file) return null;
    const line = Array.isArray(loc) ? loc[1] : loc.line;
    const column = Array.isArray(loc) ? loc[2] : loc.column;
    // Svelte 4 counts lines from 0, and Svelte 5 from 1. Svelte 5 keeps,
    // under parent, each component the element is in: the file of each
    // is where the one inside it was written.
    const svelte5 = "parent" in meta;
    const names = [baseName(file)];
    for (let p = meta.parent; p && names.length < ${MAX_NAMES}; p = p.parent) {
      if (p.type !== "component" || !p.file) continue;
      const name = baseName(p.file);
      if (name !== names[names.length - 1]) names.push(name);
    }
    const at = typeof line === "number" ? ":" + (svelte5 ? line : line + 1) + (typeof column === "number" ? ":" + (column + 1) : "") : "";
    return { framework: "Svelte", names, source: String(file) + at };
  };

  const angular = () => {
    const ng = globalThis.ng;
    if (!ng || typeof ng.getOwningComponent !== "function") return null;
    const names = [];
    let component;
    try {
      component = (ng.getComponent && ng.getComponent(el)) || ng.getOwningComponent(el);
      for (let c = component; c && names.length < ${MAX_NAMES};) {
        names.push(c.constructor && c.constructor.name ? c.constructor.name : "?");
        const hostEl = ng.getHostElement && ng.getHostElement(c);
        c = hostEl ? ng.getOwningComponent(hostEl) : null;
      }
    } catch {
      return null;
    }
    if (names.length === 0) return null;
    return { framework: "Angular", names };
  };

  for (const read of [react, vue3, vue2, svelte, angular]) {
    try {
      const found = read();
      if (found) return found;
    } catch {
      // A shape it does not know: try the next.
    }
  }
  return null;
}`;
