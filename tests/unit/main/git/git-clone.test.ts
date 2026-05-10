/**
 * Scenario tests for the workspace-agnostic clone backend.
 */
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import { runClone } from "../../../../src/main/git/git-clone";
import type { GitCloneEvent } from "../../../../src/shared/types/git";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("runClone", () => {
  it("rejects a pre-existing destination before invoking git", async () => {
    const parent = await makeTempDir();
    await fs.promises.mkdir(path.join(parent, "repo"));

    await expect(
      runClone(
        {
          bin: "git-that-should-not-run",
          url: "https://example.invalid/repo.git",
          destination: parent,
          name: "repo",
        },
        () => {},
      ),
    ).rejects.toMatchObject({ kind: "clone-destination-exists" } satisfies Partial<GitError>);

    await expect(fs.promises.stat(path.join(parent, "repo"))).resolves.toBeDefined();
  });

  it("cancels a running clone and removes only the owned destination", async () => {
    const parent = await makeTempDir();
    const bin = await writeFakeGit(
      parent,
      `
const fs = require("node:fs");
const path = require("node:path");
const target = process.argv.at(-1);
fs.writeFileSync(path.join(target, "partial.txt"), "owned");
process.stderr.write("Receiving objects: 60% (6/10)\\n");
setInterval(() => {}, 1000);
`,
    );
    const events: GitCloneEvent[] = [];
    const controller = new AbortController();

    const clone = runClone(
      {
        bin,
        url: "https://example.invalid/repo.git",
        destination: parent,
        name: "repo",
      },
      (event) => events.push(event),
      controller.signal,
    );

    await waitFor(() => events.some((event) => event.kind === "progress" && event.pct >= 60));
    controller.abort();

    await expect(clone).resolves.toEqual({
      kind: "cancelled",
      absPath: path.join(parent, "repo"),
      cleaned: true,
    });
    expect(events.at(-1)).toMatchObject({ kind: "cancelled", cleaned: true });
    await expect(pathExists(path.join(parent, "repo"))).resolves.toBe(false);
  });

  it("uses helper askpass environment for successful clone processes", async () => {
    const parent = await makeTempDir();
    const envLog = path.join(parent, "env.json");
    const bin = await writeFakeGit(
      parent,
      `
const fs = require("node:fs");
const payload = {
  argv: process.argv.slice(2),
  gitAskpass: process.env.GIT_ASKPASS,
  sshAskpass: process.env.SSH_ASKPASS,
  sshAskpassRequire: process.env.SSH_ASKPASS_REQUIRE,
  terminalPrompt: process.env.GIT_TERMINAL_PROMPT,
};
fs.writeFileSync(process.env.NEXUS_CLONE_TEST_LOG, JSON.stringify(payload));
process.stderr.write("Updating files: 100% (1/1)\\n");
`,
    );
    const events: GitCloneEvent[] = [];

    const result = await runClone(
      {
        bin,
        url: "git@github.com:org/repo.git",
        destination: parent,
        name: "repo",
        branch: "main",
        recurseSubmodules: true,
        env: { NEXUS_CLONE_TEST_LOG: envLog },
      },
      (event) => events.push(event),
    );

    const payload = JSON.parse(await fs.promises.readFile(envLog, "utf8")) as {
      argv: string[];
      gitAskpass?: string;
      sshAskpass?: string;
      sshAskpassRequire?: string;
      terminalPrompt?: string;
    };

    expect(result).toEqual({ kind: "complete", absPath: path.join(parent, "repo") });
    expect(events.map((event) => event.kind)).toContain("started");
    expect(events.at(-1)).toEqual(result);
    expect(payload.argv).toContain("--branch");
    expect(payload.argv).toContain("--recurse-submodules");
    expect(payload.gitAskpass).toBeTruthy();
    expect(payload.sshAskpass).toBeTruthy();
    expect(payload.sshAskpassRequire).toBe("force");
    expect(payload.terminalPrompt).toBe("0");
  });
});

/** Creates a tracked temp directory for this test file. */
async function makeTempDir(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-clone-test-"));
  tempRoots.push(root);
  return root;
}

/** Writes an executable Node fake-git script into the temp root. */
async function writeFakeGit(root: string, body: string): Promise<string> {
  const script = path.join(root, `fake-git-${Math.random().toString(36).slice(2)}.cjs`);
  await fs.promises.writeFile(script, `#!/usr/bin/env node\n${body.trim()}\n`, {
    mode: 0o755,
  });
  await fs.promises.chmod(script, 0o755);
  return script;
}

/** Waits for an eventually true condition raised by the fake git process. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

/** Checks path existence without throwing on ENOENT. */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.promises.access(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
