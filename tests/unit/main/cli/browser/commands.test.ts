/**
 * nexus browser snapshot, click, fill, type, press, screenshot, eval,
 * console and wait, against a fake driver: which tab they act on, what they
 * print, where screenshots go, and that only the ones changing a page ask
 * leave for another workspace.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { runCli } from "../../../../../src/main/features/cli/registry";
import {
  API,
  APP,
  BROWSER_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
  SHELL_TAB,
} from "../fake-services";

async function nexus(
  app: FakeApp,
  argv: string[],
  invocation: { cwd?: string; stdin?: string } = {},
) {
  return runCli(
    CLI_COMMANDS,
    contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }, invocation),
  );
}

describe("reading a page", () => {
  test("snapshot prints the title, URL and tree of the workspace's browser tab", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "snapshot", "--max-lines", "50"]);
    expect(result.stdout).toBe('Vite App — http://localhost:5173/\n- button "Sign in" [ref=e1]\n');
    expect(app.browser.calls).toEqual([
      { op: "snapshot", tabId: BROWSER_TAB, args: [{ maxLines: 50 }] },
    ]);
  });

  test("screenshot saves in the temp directory, or where --out says from this directory", async () => {
    const app = fakeApp();
    app.time.now = 1_000;
    const temp = await nexus(app, ["browser", "screenshot"]);
    expect(temp.stdout).toBe("Saved /tmp/nexus-browser-aaaaaaaa-1000.png\n");
    expect(temp.files).toEqual([{ path: "/tmp/nexus-browser-aaaaaaaa-1000.png", base64: "cG5n" }]);
    const out = await nexus(app, ["browser", "screenshot", "--out", "shots/a.png", "--full"], {
      cwd: "/w/app/src",
    });
    expect(out.files?.[0]?.path).toBe("/w/app/src/shots/a.png");
    expect(app.browser.calls.at(-1)?.args).toEqual([{ full: true }]);
  });

  test("a Windows terminal's screenshot path follows Windows rules", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "screenshot", "--out", "a.png"], {
      cwd: "C:\\w\\app",
    });
    expect(result.files?.[0]?.path).toBe("C:\\w\\app\\a.png");
  });

  test("console prints messages and page loads; --errors keeps errors and warnings", async () => {
    const app = fakeApp();
    const at = new Date(2026, 0, 1, 9, 5, 7).getTime();
    app.browser.console = [
      { at, level: "page", text: "http://localhost:5173/" },
      { at, level: "info", text: "ready" },
      {
        at,
        level: "error",
        text: "Uncaught TypeError: x is undefined",
        source: "http://localhost:5173/main.js:12",
      },
    ];
    expect((await nexus(app, ["browser", "console"])).stdout).toBe(
      "09:05:07 ── loaded http://localhost:5173/\n" +
        "09:05:07 info    ready\n" +
        "09:05:07 error   Uncaught TypeError: x is undefined  (http://localhost:5173/main.js:12)\n",
    );
    const errors = await nexus(app, ["browser", "console", "--errors", "--clear"]);
    expect(errors.stdout).not.toContain("ready");
    expect(app.browser.calls.at(-1)).toEqual({ op: "console", tabId: BROWSER_TAB, args: [true] });
  });

  test("wait exits 124 when the condition does not come, and takes one condition", async () => {
    const app = fakeApp();
    app.browser.met = false;
    const result = await nexus(app, ["browser", "wait", "--text", "Welcome", "--timeout", "5s"]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe('Gave up waiting for the text "Welcome".\n');
    expect(app.browser.calls.at(-1)?.args).toEqual([
      { kind: "text", text: "Welcome", gone: false },
      5_000,
    ]);
    expect((await nexus(app, ["browser", "wait", "--text", "a", "--selector", "b"])).exitCode).toBe(
      2,
    );
    expect((await nexus(app, ["browser", "wait", "--gone"])).exitCode).toBe(2);
    app.browser.met = true;
    expect((await nexus(app, ["browser", "wait"])).stdout).toBe(
      "Done waiting for the page to load.\n",
    );
  });
});

describe("driving a page", () => {
  test("click, fill, type and press pass the element and text to the driver", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["browser", "click", "e3", "--double"])).stdout).toBe("Clicked e3.\n");
    await nexus(app, ["browser", "fill", "#email", "me@x.io"]);
    await nexus(app, ["browser", "fill", "e2", ""]);
    await nexus(app, ["browser", "type", "hello", "world", "--into", "e4"]);
    await nexus(app, ["browser", "press", "ctrl-a", "Backspace"]);
    expect(app.browser.calls.map((c) => [c.op, ...c.args])).toEqual([
      ["click", "e3", { double: true, force: false }],
      ["fill", "#email", "me@x.io"],
      ["fill", "e2", ""],
      ["type", "hello world", "e4"],
      ["press", ["ctrl-a", "Backspace"]],
    ]);
  });

  test("fill and eval read standard input for -", async () => {
    const app = fakeApp();
    await nexus(app, ["browser", "fill", "e1", "-"], { stdin: "two\nlines\n" });
    app.browser.value = { ok: true, n: 2 };
    const result = await nexus(app, ["browser", "eval", "-"], { stdin: "({ ok: true, n: 2 })" });
    expect(app.browser.calls.map((c) => c.args.at(-1))).toEqual([
      "two\nlines",
      "({ ok: true, n: 2 })",
    ]);
    expect(result.stdout).toBe('{\n  "ok": true,\n  "n": 2\n}\n');
  });

  test("eval prints strings as they are and undefined as such", async () => {
    const app = fakeApp();
    app.browser.value = "Vite App";
    expect((await nexus(app, ["browser", "eval", "document.title"])).stdout).toBe("Vite App\n");
    app.browser.value = undefined;
    expect((await nexus(app, ["browser", "eval", "void 0"])).stdout).toBe("undefined\n");
  });

  test("changing another workspace's page asks; reading it does not", async () => {
    const app = fakeApp();
    app.tabs[API]?.push({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      type: "browser",
      title: "API docs",
      shown: true,
      url: "http://localhost:8080/docs",
    } as never);
    await nexus(app, ["browser", "snapshot", "--workspace", "api"]);
    await nexus(app, ["browser", "screenshot", "--workspace", "api"]);
    expect(app.asked).toEqual([]);
    const refused = await nexus(app, ["browser", "click", "e1", "--workspace", "api"]);
    expect(refused.exitCode).toBe(1);
    expect(app.asked.map((r) => r.change)).toEqual([
      { kind: "browserControl", detail: "API docs" },
    ]);
  });
});
