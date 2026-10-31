/**
 * nexus browser snapshot's tree: grouping nodes left out, text joined, a
 * button's own text not repeated, and a ref for each element.
 */
import { describe, expect, test } from "bun:test";
import { type AxNode, buildSnapshot } from "../../../../../src/main/features/cli/browser/snapshot";

let next = 0;
function node(
  role: string,
  name: string,
  children: AxNode[] = [],
  extra: Partial<AxNode> & { props?: Record<string, unknown> } = {},
): AxNode[] {
  const id = String(++next);
  const { props, ...rest } = extra;
  const self: AxNode = {
    nodeId: id,
    ignored: false,
    role: { value: role },
    name: { value: name },
    childIds: children.filter((c) => c.parentId === undefined).map((c) => c.nodeId),
    backendDOMNodeId: 100 + Number(id),
    ...(props
      ? { properties: Object.entries(props).map(([n, value]) => ({ name: n, value: { value } })) }
      : {}),
    ...rest,
  };
  return [self, ...children.map((c) => (c.parentId === undefined ? { ...c, parentId: id } : c))];
}

/** Flattens node() results into one list, the first node of each being a child. */
function tree(
  role: string,
  name: string,
  kids: AxNode[][],
  extra: Parameters<typeof node>[3] = {},
): AxNode[] {
  const firsts = kids.map((k) => k[0] as AxNode);
  const [self, ...direct] = node(role, name, firsts, extra);
  const rest = kids.flatMap((k) => k.slice(1));
  return [self as AxNode, ...direct, ...rest];
}

function signInPage(): AxNode[] {
  next = 0;
  return tree("RootWebArea", "QA Form", [
    tree("generic", "", [
      tree("heading", "Sign in", [node("StaticText", "Sign in")], { props: { level: 1 } }),
      tree("form", "", [
        tree("LabelText", "", [node("StaticText", "Email")]),
        tree("textbox", "Email", [tree("generic", "", [node("StaticText", "me@x.io")])], {
          value: { value: "me@x.io" },
          props: { focused: true },
        }),
        tree("generic", "", [node("checkbox", "Remember me", [], { props: { checked: "true" } })], {
          ignored: true,
        }),
        tree("combobox", "Plan", [tree("MenuListPopup", "", [node("option", "Free")])], {
          value: { value: "Free" },
        }),
        tree("button", "Sign in", [node("StaticText", "Sign in")]),
      ]),
      tree("paragraph", "", [node("StaticText", "Read the"), node("StaticText", "terms.")]),
      tree("link", "Next page", [node("StaticText", "Next page")], {
        props: { url: "http://x/page2.html" },
      }),
    ]),
  ]);
}

describe("buildSnapshot", () => {
  test("prints elements with refs and marks, groups left out and text joined", () => {
    const snap = buildSnapshot(signInPage(), { maxLines: 100 });
    expect(snap.text).toBe(
      [
        '- heading "Sign in" [level=1] [ref=e1]',
        "- form [ref=e2]",
        "  - text: Email",
        '  - textbox "Email" [focused] [value="me@x.io"] [ref=e3]',
        '  - checkbox "Remember me" [checked] [ref=e4]',
        '  - combobox "Plan" [value="Free"] [ref=e5]',
        '  - button "Sign in" [ref=e6]',
        "- text: Read the terms.",
        '- link "Next page" [url=http://x/page2.html] [ref=e7]',
      ].join("\n"),
    );
    expect(snap.refs.get("e6")).toEqual({
      backendNodeId: expect.any(Number),
      role: "button",
      name: "Sign in",
    });
    expect(snap.omitted).toBe(0);
  });

  test("stops at maxLines and counts what it left out", () => {
    const snap = buildSnapshot(signInPage(), { maxLines: 3 });
    expect(snap.text.split("\n")).toHaveLength(3);
    expect(snap.omitted).toBe(6);
    expect([...snap.refs.keys()]).toEqual(["e1", "e2"]);
  });

  test("within prints one element and what is inside it", () => {
    const nodes = signInPage();
    const form = nodes.find((n) => n.role?.value === "form") as AxNode;
    const snap = buildSnapshot(nodes, { maxLines: 100, within: form.backendDOMNodeId as number });
    expect(snap.text.split("\n")[0]).toBe("- form [ref=e1]");
    expect(snap.text).not.toContain("heading");
  });
});
