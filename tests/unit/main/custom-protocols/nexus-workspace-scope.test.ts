import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import { previewScopeUrl } from "../../../../src/shared/preview/scope-url";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

const { buildNexusWorkspaceHandler } = await import(
  "../../../../src/main/features/custom-protocols/nexus-workspace"
);
const { PreviewScopes } = await import(
  "../../../../src/main/features/custom-protocols/preview-scopes"
);
const { setOutsideGrant, clearOutsideGrants } = await import(
  "../../../../src/main/features/fs/outside-grants"
);
const { buildOutsideUrl } = await import(
  "../../../../src/renderer/services/editor/preview/workspace-url"
);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scope-proto-")));
const root = path.join(tmp, "proj");
const report = path.join(tmp, "out", "Report");
const secret = path.join(tmp, "out", "secret.txt");
fs.mkdirSync(root);
fs.mkdirSync(path.join(report, "img"), { recursive: true });
fs.writeFileSync(path.join(report, "index.html"), "<p>r</p>");
fs.writeFileSync(path.join(report, "style.css"), "p{}");
fs.writeFileSync(path.join(report, "img", "a.png"), "png");
fs.writeFileSync(secret, "secret");
fs.symlinkSync(secret, path.join(report, "link.txt"));
fs.symlinkSync(path.dirname(secret), path.join(report, "up"));
afterAll(() => {
  clearOutsideGrants();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const workspace = {
  list: () => [
    {
      id: "ws",
      name: "w",
      pinned: false,
      tabs: [],
      rootPath: root,
      location: { kind: "local", rootPath: root },
    } as unknown as WorkspaceMeta,
  ],
  getFs: async () => {
    throw new Error("no agent");
  },
} as unknown as WorkspaceManager;

function scoped() {
  const scopes = new PreviewScopes("/home/nobody");
  const id = scopes.open(1, "ws", report);
  if (!id) throw new Error("no scope");
  const handler = buildNexusWorkspaceHandler(workspace, undefined, scopes);
  const ask = (rest: string) => handler(new Request(`${previewScopeUrl(id)}${rest}`));
  return { scopes, id, ask, handler };
}

describe("nexus-workspace:// preview folders", () => {
  test("serves the html's folder and the folders under it, readable by the page", async () => {
    const { ask } = scoped();
    const css = await ask("style.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toBe("p{}");
    expect(css.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await ask("img/a.png")).status).toBe(200);
  });

  test("serves nothing outside the folder, however the path is written", async () => {
    const { ask } = scoped();
    for (const rest of [
      "../secret.txt",
      "..%2fsecret.txt",
      "..%2Fsecret.txt",
      "..%5csecret.txt",
      "%2e%2e/secret.txt",
      "%2e%2e%2fsecret.txt",
      "img/..%2f..%2fsecret.txt",
      "link.txt",
      "up/secret.txt",
      `${encodeURIComponent(secret)}`,
      "",
      "img/",
    ]) {
      expect((await ask(rest)).status).toBe(404);
    }
  });

  test("a folder opened in another case, on a disk that folds case, still holds to itself", async () => {
    const folded = report.replace("Report", "report");
    if (!fs.existsSync(folded)) return;
    const scopes = new PreviewScopes("/home/nobody");
    const id = scopes.open(1, "ws", folded);
    if (!id) throw new Error("no scope");
    const handler = buildNexusWorkspaceHandler(workspace, undefined, scopes);
    expect((await handler(new Request(`${previewScopeUrl(id)}style.css`))).status).toBe(200);
    expect((await handler(new Request(`${previewScopeUrl(id)}link.txt`))).status).toBe(404);
  });

  test("serves nothing for a folder never opened or one let go of", async () => {
    const { scopes, id, handler } = scoped();
    const other = "f".repeat(32);
    expect((await handler(new Request(`${previewScopeUrl(other)}style.css`))).status).toBe(404);
    scopes.releaseOwner(1);
    expect((await handler(new Request(`${previewScopeUrl(id)}style.css`))).status).toBe(404);
  });

  test("a folder does not open the outside grants: a granted file elsewhere stays out", async () => {
    setOutsideGrant("ws", "tab", [secret], []);
    const { ask, handler } = scoped();
    expect((await ask("../secret.txt")).status).toBe(404);
    const granted = await handler(new Request(buildOutsideUrl("ws", secret)));
    expect(await granted.text()).toBe("secret");
  });
});
