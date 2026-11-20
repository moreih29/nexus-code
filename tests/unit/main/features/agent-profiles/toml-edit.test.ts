import { describe, expect, test } from "bun:test";
import {
  checkToml,
  editToml,
  readTomlKey,
} from "../../../../../src/main/features/agent-profiles/toml-edit";

const set = (text: string, path: string[], value: string | number | boolean | undefined) => {
  const out = editToml(text, [{ path, value }]);
  if (!out.ok) throw new Error(out.message);
  return out.text;
};

describe("reading config.toml", () => {
  test("top-level and table keys, with Bun's parser as the reference", () => {
    const text = [
      "# my config",
      'model = "gpt-5"',
      "approval_policy = 'never'",
      "model_auto_compact_token_limit = 100_000",
      "",
      "[sandbox_workspace_write]",
      "network_access = true # why",
      "",
      "[profiles.fast]",
      'model = "x"',
      "",
    ].join("\n");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(readTomlKey(text, ["model"])).toEqual({ state: "value", value: parsed.model });
    expect(readTomlKey(text, ["approval_policy"])).toEqual({ state: "value", value: "never" });
    expect(readTomlKey(text, ["model_auto_compact_token_limit"])).toEqual({
      state: "value",
      value: 100000,
    });
    expect(readTomlKey(text, ["sandbox_workspace_write", "network_access"])).toEqual({
      state: "value",
      value: true,
    });
    expect(readTomlKey(text, ["web_search"])).toEqual({ state: "absent" });
  });

  test("dotted keys, quoted keys and escapes read as the same path", () => {
    const text = 'sandbox_workspace_write.network_access = false\n"model" = "a\\tb\\u00e9"\n';
    expect(readTomlKey(text, ["sandbox_workspace_write", "network_access"])).toEqual({
      state: "value",
      value: false,
    });
    expect(readTomlKey(text, ["model"])).toEqual({ state: "value", value: "a\tbé" });
  });

  test("arrays, inline tables and multi-line strings are skipped whole", () => {
    const text = [
      'notify = ["a", # c',
      '  "b]"',
      "]",
      "x = { a = 1, b = [1, 2] }",
      'doc = """',
      "model = 'not a key'",
      '"""',
      'model = "real"',
      "[[servers]]",
      'model = "other"',
      "",
    ].join("\n");
    expect(checkToml(text)).toBeNull();
    expect(readTomlKey(text, ["model"])).toEqual({ state: "value", value: "real" });
    expect(readTomlKey(text, ["notify"])).toEqual({ state: "unsupported" });
  });

  test("a file that is not TOML is broken", () => {
    expect(checkToml("model = \n")).not.toBeNull();
    expect(checkToml("model = 'x\n")).not.toBeNull();
    expect(checkToml("[table\nx = 1\n")).not.toBeNull();
    expect(checkToml("just words\n")).not.toBeNull();
    expect(checkToml("a = 1 b = 2\n")).not.toBeNull();
  });
});

describe("editing config.toml", () => {
  test("changes only the value, keeping comments and the rest of the line", () => {
    const text = '# top\nmodel = "a"   # keep me\n\n[x]\nk = 1\n';
    expect(set(text, ["model"], "b")).toBe('# top\nmodel = "b"   # keep me\n\n[x]\nk = 1\n');
  });

  test("adds a top-level key after the last top-level key, before the first table", () => {
    const text = '# c\nmodel = "a"\n\n# about x\n[x]\nk = 1\n';
    expect(set(text, ["approval_policy"], "never")).toBe(
      '# c\nmodel = "a"\napproval_policy = "never"\n\n# about x\n[x]\nk = 1\n',
    );
  });

  test("adds a top-level key above the first table's comments when there are no keys", () => {
    const text = "# hello\n\n# about x\n[x]\nk = 1\n";
    expect(set(text, ["a"], 1)).toBe("# hello\n\na = 1\n\n# about x\n[x]\nk = 1\n");
  });

  test("adds a key to an empty or comment-only file", () => {
    expect(set("", ["a"], true)).toBe("a = true\n");
    expect(set("# only\n", ["a"], true)).toBe("# only\na = true\n");
    expect(set("x = 1", ["a"], true)).toBe("x = 1\na = true\n");
  });

  test("adds a key into an existing table, after its last key", () => {
    const text = "[sandbox_workspace_write]\nwritable_roots = [\n  '/a',\n]\n\n[other]\nz = 1\n";
    expect(set(text, ["sandbox_workspace_write", "network_access"], true)).toBe(
      "[sandbox_workspace_write]\nwritable_roots = [\n  '/a',\n]\nnetwork_access = true\n\n[other]\nz = 1\n",
    );
  });

  test("makes a new table at the end, with a blank line before it", () => {
    expect(set("a = 1\n", ["sandbox_workspace_write", "network_access"], true)).toBe(
      "a = 1\n\n[sandbox_workspace_write]\nnetwork_access = true\n",
    );
    expect(set("a = 1\n\n", ["t", "k"], 1)).toBe("a = 1\n\n[t]\nk = 1\n");
  });

  test("a table written with dotted keys gets a dotted key", () => {
    const text = "sandbox_workspace_write.writable_roots = []\nmodel = 'a'\n";
    const out = set(text, ["sandbox_workspace_write", "network_access"], true);
    expect(out).toBe(
      "sandbox_workspace_write.writable_roots = []\nsandbox_workspace_write.network_access = true\nmodel = 'a'\n",
    );
    expect((Bun.TOML.parse(out) as any).sandbox_workspace_write.network_access).toBe(true);
  });

  test("changes a dotted key in place", () => {
    const text = "sandbox_workspace_write.network_access = false # no\n";
    expect(set(text, ["sandbox_workspace_write", "network_access"], true)).toBe(
      "sandbox_workspace_write.network_access = true # no\n",
    );
  });

  test("removes a key with its line, and only that", () => {
    const text = "# c\na = 1\nmodel = 'x' # why\nb = 2\n[t]\nmodel = 'y'\n";
    expect(set(text, ["model"], undefined)).toBe("# c\na = 1\nb = 2\n[t]\nmodel = 'y'\n");
    expect(set(text, ["nothing"], undefined)).toBe(text);
  });

  test("edits next to a multi-line value without touching it", () => {
    const text = "a = 1\nx = [\n  1,\n  2,\n]\nb = 2\n";
    expect(set(text, ["b"], undefined)).toBe("a = 1\nx = [\n  1,\n  2,\n]\n");
    expect(set(text, ["a"], 5)).toBe("a = 5\nx = [\n  1,\n  2,\n]\nb = 2\n");
  });

  test("keeps CRLF line endings", () => {
    const out = set("a = 1\r\n[t]\r\nk = 1\r\n", ["t", "j"], 2);
    expect(out).toBe("a = 1\r\n[t]\r\nk = 1\r\nj = 2\r\n");
    expect(set("a = 1\r\n", ["b"], "x")).toBe('a = 1\r\nb = "x"\r\n');
  });

  test("strings are written escaped", () => {
    const out = set("", ["model"], 'a "q"\\ \n');
    expect((Bun.TOML.parse(out) as any).model).toBe('a "q"\\ \n');
  });

  test("every edit keeps the file valid", () => {
    let text = "# c\n[t]\nk = 1\n";
    for (const [path, value] of [
      [["a"], 1],
      [["t", "j"], true],
      [["u", "v", "w"], "x"],
      [["a"], undefined],
    ] as const) {
      text = set(text, [...path], value);
      expect(checkToml(text)).toBeNull();
      Bun.TOML.parse(text);
    }
  });

  test("shapes it cannot change safely are refused, not rewritten", () => {
    for (const [text, path] of [
      ["approval_policy = { granular = true }\n", ["approval_policy"]],
      ["model = ['a']\n", ["model"]],
      ['model = """a\nb"""\n', ["model"]],
      [
        "sandbox_workspace_write = { network_access = false }\n",
        ["sandbox_workspace_write", "network_access"],
      ],
      ["[approval_policy.granular]\nx = 1\n", ["approval_policy"]],
      ["model = 'a'\nmodel = 'b'\n", ["model"]],
    ] as const) {
      for (const value of ["x", undefined]) {
        const out = editToml(text, [{ path: [...path], value }]);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe("unsupported");
      }
    }
  });

  test("a broken file is refused", () => {
    const out = editToml("model = \n", [{ path: ["a"], value: 1 }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("broken");
  });
});
