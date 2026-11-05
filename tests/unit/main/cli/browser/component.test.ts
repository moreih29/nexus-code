/**
 * The component nexus browser pick names for an element: DESCRIBE_COMPONENT
 * run here on stand-ins for what each framework's development build leaves
 * on the DOM node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  DESCRIBE_COMPONENT,
  type PickedComponent,
} from "../../../../../src/main/features/cli/browser/component";
import { formatPick, type PickedElement } from "../../../../../src/main/features/cli/browser/pick";

const describeComponent = new Function(`return ${DESCRIBE_COMPONENT}`)() as (
  this: object,
) => PickedComponent | null;

function componentOf(el: object): PickedComponent | null {
  return describeComponent.call(el);
}

/** A DOM node: its parent, and what a framework set on it. */
function node(expandos: Record<string, unknown> = {}, parentNode: object | null = null): object {
  return Object.assign({ parentNode }, expandos);
}

function LoginForm() {}
function AuthPage() {}
function App() {}
function handleSubmit() {}

describe("React", () => {
  /** The fibers above a <button> LoginForm draws, in AuthPage (forwardRef) in App (memo). */
  function fibers(host: Record<string, unknown>) {
    const app = { type: { $$typeof: Symbol.for("react.memo"), type: App }, return: null };
    const page = {
      type: { $$typeof: Symbol.for("react.forward_ref"), render: AuthPage },
      return: { type: "div", return: app },
    };
    const form = {
      type: LoginForm,
      memoizedProps: {
        title: "Sign in",
        disabled: false,
        tries: 3,
        onSubmit: handleSubmit,
        style: { color: "red" },
        items: [1, 2],
        children: "ignored",
      },
      return: page,
    };
    return { ...host, return: { type: "form", return: form } };
  }

  test("React 18 names the components and where the element is written", () => {
    const button = node({
      __reactFiber$x1y2: fibers({
        type: "button",
        _debugSource: { fileName: "/app/src/LoginForm.tsx", lineNumber: 42, columnNumber: 7 },
      }),
    });
    expect(componentOf(button)).toEqual({
      framework: "React",
      names: ["LoginForm", "AuthPage", "App"],
      source: "/app/src/LoginForm.tsx:42:7",
      props: {
        title: '"Sign in"',
        disabled: "false",
        tries: "3",
        onSubmit: "ƒ handleSubmit",
        style: "{…}",
        items: "[2 items]",
      },
    });
  });

  test("React 19 tells the file from where the element was made, past React's own frame", () => {
    const stack = [
      "Error: react-stack-top-frame",
      "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=9a1:250:12)",
      "    at LoginForm (http://localhost:5173/src/LoginForm.tsx?t=1712:20:5)",
      "    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=9a1:1:1)",
    ].join("\n");
    const button = node({ __reactFiber$q: fibers({ type: "button", _debugStack: { stack } }) });
    expect(componentOf(button)?.source).toBe("/src/LoginForm.tsx");

    const webpack =
      "Error\n    at jsxDEV (webpack-internal:///./node_modules/react/cjs/x.js:1:1)\n    at LoginForm (webpack-internal:///./src/LoginForm.tsx:12:5)";
    const other = node({
      __reactFiber$q: fibers({ type: "button", _debugStack: { stack: webpack } }),
    });
    expect(componentOf(other)?.source).toBe("./src/LoginForm.tsx");
  });

  test("React 16's key works, and a production build tells only names", () => {
    const button = node({ __reactInternalInstance$abc: fibers({ type: "button" }) });
    const found = componentOf(button);
    expect(found?.names).toEqual(["LoginForm", "AuthPage", "App"]);
    expect(found?.source).toBeUndefined();
  });
});

describe("Vue", () => {
  test("Vue 3 names the component, its file and props, and those it is in", () => {
    const el = node({
      __vueParentComponent: {
        type: { __name: "LoginForm", __file: "/app/src/LoginForm.vue" },
        props: { title: "Sign in" },
        parent: { type: { name: "App" }, parent: null },
      },
    });
    expect(componentOf(el)).toEqual({
      framework: "Vue",
      names: ["LoginForm", "App"],
      source: "/app/src/LoginForm.vue",
      props: { title: '"Sign in"' },
    });
  });

  test("Vue 2 finds the component on the nearest root element above", () => {
    const root = node({
      __vue__: {
        $options: { _componentTag: "login-form", __file: "src/LoginForm.vue" },
        $props: { title: "Sign in" },
        $parent: { $options: { name: "App" }, $parent: undefined },
      },
    });
    const input = node({}, node({}, root));
    expect(componentOf(input)).toEqual({
      framework: "Vue",
      names: ["login-form", "App"],
      source: "src/LoginForm.vue",
      props: { title: '"Sign in"' },
    });
  });
});

describe("Svelte", () => {
  test("Svelte 4 counts lines from 0, so the line shown is one more", () => {
    const el = node({
      __svelte_meta: { loc: { file: "src/Login.svelte", line: 11, column: 4, char: 300 } },
    });
    expect(componentOf(el)).toEqual({
      framework: "Svelte",
      names: ["Login"],
      source: "src/Login.svelte:12:5",
    });
  });

  test("Svelte 5 counts lines from 1, and names the components it is in", () => {
    // <Login/> written in Page.svelte, inside an {#each} of App.svelte's.
    const el = node({
      __svelte_meta: {
        loc: { file: "src/Login.svelte", line: 12, column: 4 },
        parent: {
          type: "component",
          file: "src/Page.svelte",
          componentTag: "Login",
          line: 3,
          column: 0,
          parent: {
            type: "each",
            file: "src/App.svelte",
            parent: {
              type: "component",
              file: "src/App.svelte",
              componentTag: "Page",
              parent: null,
            },
          },
        },
      },
    });
    expect(componentOf(el)).toEqual({
      framework: "Svelte",
      names: ["Login", "Page", "App"],
      source: "src/Login.svelte:12:5",
    });
  });
});

describe("Angular", () => {
  afterEach(() => {
    delete (globalThis as { ng?: unknown }).ng;
  });

  test("the ng global names the component that owns the element, and its owners", () => {
    class LoginFormComponent {}
    class AppComponent {}
    const form = new LoginFormComponent();
    const app = new AppComponent();
    const formHost = node();
    const el = node();
    (globalThis as { ng?: unknown }).ng = {
      getComponent: () => null,
      getOwningComponent: (n: object) => (n === el ? form : n === formHost ? app : null),
      getHostElement: (c: object) => (c === form ? formHost : null),
    };
    expect(componentOf(el)).toEqual({
      framework: "Angular",
      names: ["LoginFormComponent", "AppComponent"],
    });
  });
});

test("an element no framework made has no component", () => {
  expect(componentOf(node({ id: "x" }, node()))).toBeNull();
});

test("a getter on the node is never run", () => {
  let ran = false;
  const el = node();
  Object.defineProperty(el, "__reactFiber$z", {
    enumerable: true,
    get() {
      ran = true;
      return {};
    },
  });
  expect(componentOf(el)).toBeNull();
  expect(ran).toBe(false);
});

test("pick prints the component, where it is written and its props", () => {
  const picked: PickedElement = {
    url: "http://localhost:5173/",
    title: "App",
    role: "button",
    name: "Sign in",
    ref: "e4",
    tag: "button",
    selector: "#signin",
    inShadow: false,
    text: "Sign in",
    html: '<button id="signin">Sign in</button>',
    box: { x: 1, y: 2, width: 80, height: 24 },
    clip: null,
    component: {
      framework: "React",
      names: ["LoginForm", "AuthPage", "App"],
      source: "/app/src/LoginForm.tsx:42:7",
      props: { title: '"Sign in"', onSubmit: "ƒ handleSubmit" },
    },
  };
  expect(formatPick(picked).split("\n").slice(-3)).toEqual([
    "  component: LoginForm (React), in AuthPage < App",
    "  source: /app/src/LoginForm.tsx:42:7",
    '  props: {title: "Sign in", onSubmit: ƒ handleSubmit}',
  ]);
});
