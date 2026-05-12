import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFsProvider } from "../../../../src/main/fs/provider/local/local-fs-provider";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-local-fs-provider-"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

async function makeWorkspaceRoot(): Promise<string> {
  const workspaceRoot = path.join(tmpRoot, "workspace");
  await fs.promises.mkdir(workspaceRoot);
  return workspaceRoot;
}

function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

describe("LocalFsProvider", () => {
  it("resolves relative reads from its injected workspace root instead of the process cwd", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const cwdRoot = path.join(tmpRoot, "cwd-root");
    await fs.promises.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(cwdRoot, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, "src", "index.ts"), "workspace");
    await fs.promises.writeFile(path.join(cwdRoot, "src", "index.ts"), "cwd");
    process.chdir(cwdRoot);

    const result = await new LocalFsProvider(workspaceRoot).readFile("src/index.ts");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe("workspace");
  });

  it("rejects traversal outside the workspace root before disk access", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    await fs.promises.writeFile(path.join(tmpRoot, "outside.txt"), "outside");

    await expect(new LocalFsProvider(workspaceRoot).readFile("../outside.txt")).rejects.toThrow(
      "path escapes workspace root",
    );
  });

  it("reports symlinks as symlinks without following their targets for listings or stat", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const outsideRoot = path.join(tmpRoot, "outside");
    await fs.promises.mkdir(outsideRoot);
    await fs.promises.writeFile(path.join(outsideRoot, "secret.txt"), "secret");
    await fs.promises.symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "dir");

    const provider = new LocalFsProvider(workspaceRoot);
    const entries = await provider.readdir("");
    const linkEntry = entries.find((entry) => entry.name === "outside-link");
    const linkStat = await provider.stat("outside-link");

    expect(linkEntry).toEqual({ name: "outside-link", type: "symlink" });
    expect(linkStat.type).toBe("symlink");
    expect(linkStat.isSymlink).toBe(true);
  });

  it("filters configured hidden names while leaving ordinary dotfiles visible", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    await fs.promises.mkdir(path.join(workspaceRoot, ".git"));
    await fs.promises.mkdir(path.join(workspaceRoot, "node_modules"));
    await fs.promises.mkdir(path.join(workspaceRoot, "src"));
    await fs.promises.writeFile(path.join(workspaceRoot, ".env"), "SECRET=value");
    await fs.promises.writeFile(path.join(workspaceRoot, "README.md"), "# readme");

    const entries = await new LocalFsProvider(workspaceRoot).readdir("");
    const entryNames = names(entries);

    expect(entryNames).toContain("src");
    expect(entryNames).toContain(".env");
    expect(entryNames).toContain("README.md");
    expect(entryNames).not.toContain(".git");
    expect(entryNames).not.toContain("node_modules");
  });

  it("returns ok file content for existing files", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const content = "export const answer = 42;\n";
    await fs.promises.writeFile(path.join(workspaceRoot, "answer.ts"), content, "utf8");

    const result = await new LocalFsProvider(workspaceRoot).readFile("answer.ts");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe(content);
    expect(result.encoding).toBe("utf8");
    expect(result.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.isBinary).toBe(false);
  });

  it("returns missing for files that do not exist inside the workspace root", async () => {
    const workspaceRoot = await makeWorkspaceRoot();

    const result = await new LocalFsProvider(workspaceRoot).readFile("missing.ts");

    expect(result).toEqual({ kind: "missing", reason: "not-found" });
  });
});
