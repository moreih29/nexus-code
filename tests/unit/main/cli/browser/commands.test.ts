/**
 * nexus browser snapshot, click, fill, type, press, screenshot, eval,
 * console, wait and pick, against a fake driver: which tab they act on,
 * what they print, where screenshots go, and that only the ones changing a
 * page ask leave for another workspace.
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
  PICKED,
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

  test("screenshot --element cuts the picture to one element, and is not --full", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "screenshot", "--element", "e7"]);
    expect(result.exitCode).toBe(0);
    expect(app.browser.calls.at(-1)?.args).toEqual([{ full: false, element: "e7" }]);
    const both = await nexus(app, ["browser", "screenshot", "--element", "e7", "--full"]);
    expect(both.stderr).toContain("give --full or --element, not both");
  });

  test("inspect prints the element as pick does and saves its picture", async () => {
    const app = fakeApp();
    app.time.now = 1_000;
    const result = await nexus(app, ["browser", "inspect", "e7"]);
    expect(result.stdout).toBe(
      "[element] http://localhost:5173/login\n" +
        '  button "Sign in" (ref e7)\n' +
        "  selector: #login > button.primary\n" +
        "  box: 120x32 at (412, 388)\n" +
        '  html: <button class="primary" type="submit">Sign in</button>\n' +
        "  screenshot: /tmp/nexus-inspect-aaaaaaaa-1000.png\n",
    );
    expect(result.files).toEqual([
      { path: "/tmp/nexus-inspect-aaaaaaaa-1000.png", base64: "cG5n" },
    ]);
    const data = JSON.parse(
      (await nexus(app, ["browser", "inspect", "#login button", "--json"])).stdout,
    );
    expect(data.element).toMatchObject({ ref: "e7", selector: "#login > button.primary" });
    expect(data.element.png).toBeUndefined();
    expect(app.browser.calls.at(-1)).toEqual({
      op: "inspect",
      tabId: BROWSER_TAB,
      args: ["#login button"],
    });
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

  test("hover, drag and scroll pass the elements and the way to the driver", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["browser", "hover", "e3"])).stdout).toBe("Hovered over e3.\n");
    await nexus(app, ["browser", "hover", "e3", "--force"]);
    await nexus(app, ["browser", "drag", "e1", "#trash"]);
    await nexus(app, ["browser", "scroll", "down"]);
    await nexus(app, ["browser", "scroll", "Left", "--by", "120", "--within", "e5"]);
    await nexus(app, ["browser", "scroll", "bottom"]);
    await nexus(app, ["browser", "scroll", "#footer"]);
    expect(app.browser.calls.map((c) => [c.op, ...c.args])).toEqual([
      ["hover", "e3", { force: false }],
      ["hover", "e3", { force: true }],
      ["drag", "e1", "#trash"],
      ["scroll", { kind: "by", way: "down" }, undefined],
      ["scroll", { kind: "by", way: "left", amount: 120 }, "e5"],
      ["scroll", { kind: "end", end: "bottom" }, undefined],
      ["scroll", { kind: "to", target: "#footer" }, undefined],
    ]);
  });

  test("scroll takes --by only with a way, and --within not with an element", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["browser", "scroll", "top", "--by", "10"])).stderr).toContain(
      "--by goes with up, down, left or right",
    );
    expect((await nexus(app, ["browser", "scroll", "up", "--by", "0"])).stderr).toContain(
      "--by is a distance above 0",
    );
    expect((await nexus(app, ["browser", "scroll", "e4", "--within", "e2"])).stderr).toContain(
      "--within goes with a way or an end, not an element",
    );
    expect((await nexus(app, ["browser", "drag", "e1"])).exitCode).toBe(2);
    expect(app.browser.calls).toEqual([]);
  });

  test("upload gives the input files from this directory, and only a local terminal's", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "upload", "#avatar", "me.png", "/tmp/cv.pdf"], {
      cwd: "/w/app/assets",
    });
    expect(result.exitCode).toBe(0);
    expect(app.browser.calls.at(-1)?.args).toEqual([
      "#avatar",
      ["/w/app/assets/me.png", "/tmp/cv.pdf"],
    ]);
    await nexus(app, ["browser", "upload", "#avatar", ""]);
    expect(app.browser.calls.at(-1)?.args).toEqual(["#avatar", []]);
    expect((await nexus(app, ["browser", "upload", "#avatar"])).exitCode).toBe(2);
    app.workspaces[0] = {
      ...(app.workspaces[0] as (typeof app.workspaces)[number]),
      location: { kind: "ssh", host: "box", remotePath: "/srv/app" },
    };
    const remote = await nexus(app, ["browser", "upload", "#avatar", "me.png"]);
    expect(remote.stderr).toContain("upload takes files of the computer the app runs on");
  });

  test("dialog shows the page's dialog, and accept or dismiss answers it", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["browser", "dialog"])).stdout).toBe("The page shows no dialog.\n");
    app.browser.dialog = { type: "confirm", message: "Delete it?", url: "http://localhost:5173/" };
    expect((await nexus(app, ["browser", "dialog"])).stdout).toBe(
      'The page shows a confirm dialog: "Delete it?". Answer it with nexus browser dialog accept, or dismiss.\n',
    );
    await nexus(app, ["browser", "dialog", "accept"]);
    await nexus(app, ["browser", "dialog", "dismiss"]);
    expect(app.browser.calls.slice(-2).map((c) => [c.op, ...c.args])).toEqual([
      ["answerDialog", true],
      ["answerDialog", false],
    ]);
    expect((await nexus(app, ["browser", "dialog", "ok"])).stderr).toContain(
      'answer accept or dismiss, not "ok"',
    );
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
    for (const argv of [
      ["hover", "e1"],
      ["drag", "e1", "e2"],
      ["scroll", "down"],
    ]) {
      await nexus(app, ["browser", ...argv, "--workspace", "api"]);
    }
    expect(app.asked.map((r) => r.change)).toEqual(
      Array(4).fill({ kind: "browserControl", detail: "API docs" }),
    );
  });
});

describe("picking an element", () => {
  test("pick shows the tab, prints the element and saves its picture in the temp directory", async () => {
    const app = fakeApp();
    app.time.now = 1_000;
    const result = await nexus(app, ["browser", "pick"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "[element] http://localhost:5173/login\n" +
        '  button "Sign in" (ref e7)\n' +
        "  selector: #login > button.primary\n" +
        "  box: 120x32 at (412, 388)\n" +
        '  html: <button class="primary" type="submit">Sign in</button>\n' +
        "  screenshot: /tmp/nexus-pick-aaaaaaaa-1000.png\n",
    );
    expect(result.files).toEqual([{ path: "/tmp/nexus-pick-aaaaaaaa-1000.png", base64: "cG5n" }]);
    expect(app.uiCalls.filter((c) => c.op === "tab.show").map((c) => c.args)).toEqual([
      { workspaceId: APP, tabId: BROWSER_TAB },
    ]);
    expect(app.browser.calls).toEqual([
      { op: "pick", tabId: BROWSER_TAB, args: [{ timeoutMs: 120_000 }] },
    ]);
  });

  test("--json gives the element without its picture's bytes", async () => {
    const app = fakeApp();
    app.time.now = 1_000;
    const data = JSON.parse((await nexus(app, ["browser", "pick", "--json"])).stdout);
    expect(data.picked).toMatchObject({
      ref: "e7",
      role: "button",
      selector: "#login > button.primary",
      box: { x: 412, y: 388, width: 120, height: 32 },
      screenshot: "/tmp/nexus-pick-aaaaaaaa-1000.png",
    });
    expect(data.picked.png).toBeUndefined();
    expect(data.picked.clip).toBeUndefined();
  });

  test("a pick without a picture prints no screenshot line", async () => {
    const app = fakeApp();
    const { png: _png, ...picked } = PICKED;
    app.browser.pick = { picked };
    const result = await nexus(app, ["browser", "pick"]);
    expect(result.stdout).not.toContain("screenshot:");
    expect(result.files).toBeUndefined();
  });

  test("a pick that runs out exits 124; one the user cancels fails and says why", async () => {
    const app = fakeApp();
    app.browser.pick = { cancelled: "timeout" };
    const timedOut = await nexus(app, ["browser", "pick", "--timeout", "30s"]);
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stdout).toBe("No element was picked in time.\n");
    expect(app.browser.calls.at(-1)?.args).toEqual([{ timeoutMs: 30_000 }]);
    app.browser.pick = { cancelled: "escape" };
    const cancelled = await nexus(app, ["browser", "pick"]);
    expect(cancelled.exitCode).toBe(1);
    expect(cancelled.stderr).toContain("the user cancelled the pick with Esc");
    expect((await nexus(app, ["browser", "pick", "--timeout", "11m"])).exitCode).toBe(2);
  });

  test("the pick stops with the command: it gets the command's signal", async () => {
    const app = fakeApp();
    const controller = new AbortController();
    await runCli(CLI_COMMANDS, { ...contextFor(app, ["browser", "pick"]), signal: controller.signal });
    expect(app.browser.calls.at(-1)?.args).toEqual([
      { timeoutMs: 120_000, signal: controller.signal },
    ]);
  });

  test("picking in another workspace's tab does not ask", async () => {
    const app = fakeApp();
    app.tabs[API]?.push({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      type: "browser",
      title: "API docs",
      shown: true,
      url: "http://localhost:8080/docs",
    } as never);
    expect((await nexus(app, ["browser", "pick", "--workspace", "api"])).exitCode).toBe(0);
    expect(app.asked).toEqual([]);
  });
});
