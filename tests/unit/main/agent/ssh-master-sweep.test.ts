import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { sweepStaleControlDirs } from "../../../../src/main/infra/agent/ssh/master";

/**
 * Startup sweep of orphaned nexus-ssh-* control-socket directories.
 *
 * The safety property under test: the sweep must remove only directories
 * whose master is provably gone, and must never touch a directory whose
 * control socket still has a listener — that listener may belong to a
 * DIFFERENT running app instance (dev and packaged builds share os.tmpdir()).
 */
describe("sweepStaleControlDirs", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  function makeTmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-test-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
  }

  function makeControlDir(root: string): string {
    return fs.mkdtempSync(path.join(root, "nexus-ssh-"));
  }

  it("removes empty orphaned directories", async () => {
    const root = makeTmpRoot();
    const dir = makeControlDir(root);

    await sweepStaleControlDirs(root);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes a directory whose control.sock has no listener", async () => {
    const root = makeTmpRoot();
    const dir = makeControlDir(root);
    // A path with no listener behind it — connect() fails, so the sweep
    // classifies the master as dead.
    fs.writeFileSync(path.join(dir, "control.sock"), "");

    await sweepStaleControlDirs(root);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps a directory whose control.sock has a live listener", async () => {
    const root = makeTmpRoot();
    const dir = makeControlDir(root);
    const sockPath = path.join(dir, "control.sock");

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    cleanups.push(() => server.close());

    await sweepStaleControlDirs(root);

    expect(fs.existsSync(sockPath)).toBe(true);
  });

  it("keeps directories containing anything besides control.sock", async () => {
    const root = makeTmpRoot();
    const dir = makeControlDir(root);
    fs.writeFileSync(path.join(dir, "unexpected.txt"), "not ours");

    await sweepStaleControlDirs(root);

    expect(fs.existsSync(dir)).toBe(true);
  });

  it("ignores entries that are not nexus-ssh-* directories", async () => {
    const root = makeTmpRoot();
    const otherDir = path.join(root, "some-other-dir");
    fs.mkdirSync(otherDir);
    const plainFile = path.join(root, "nexus-ssh-notadir");
    fs.writeFileSync(plainFile, "");

    await sweepStaleControlDirs(root);

    expect(fs.existsSync(otherDir)).toBe(true);
    expect(fs.existsSync(plainFile)).toBe(true);
  });

  it("is a no-op when the tmp root does not exist", async () => {
    await expect(
      sweepStaleControlDirs(path.join(os.tmpdir(), "definitely-missing-root")),
    ).resolves.toBeUndefined();
  });
});
