import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GitHelpersIpcManager } from "../../../../../../../src/main/features/git/domain/helpers/ipc";

/** Talks to the helper manager over the same JSON-line socket as the editor helper. */
async function helperRequest(socketPath: string, line: string): Promise<unknown> {
  const client = net.createConnection(socketPath);
  let reply = "";
  client.setEncoding("utf8");
  client.on("data", (chunk: string) => {
    reply += chunk;
  });
  await once(client, "connect");
  client.write(line);
  await once(client, "end");
  return JSON.parse(reply);
}

test("the Git helper rejects an oversized request line and oversized editor file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-helper-limits-"));
  const prompts: unknown[] = [];
  const manager = new GitHelpersIpcManager({
    userDataDir: dir,
    token: "fixture",
    broadcast: (_channel, event, args) => {
      if (event !== "prompt") return;
      prompts.push(args);
      void manager.cancelEditor({ promptId: (args as { promptId: string }).promptId });
    },
  });
  try {
    const { socketPath } = await manager.start();
    const oversized = JSON.stringify({
      route: "invalid",
      token: "fixture",
      prompt: "한".repeat(350_000),
    });
    expect(await helperRequest(socketPath, `${oversized}\n`)).toMatchObject({
      ok: false,
      error: expect.stringContaining("request exceeds"),
    });

    const filePath = path.join(dir, "COMMIT_EDITMSG");
    await writeFile(filePath, "");
    await truncate(filePath, 4 * 1024 * 1024 + 1);
    expect(
      await helperRequest(
        socketPath,
        `${JSON.stringify({ route: "editor.open", token: "fixture", filePath })}\n`,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("file exceeds"),
    });
    expect(prompts).toEqual([]);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Git editor does not prompt when its client disconnects during the file read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-helper-disconnect-"));
  const prompts: unknown[] = [];
  const manager = new GitHelpersIpcManager({
    userDataDir: dir,
    token: "fixture",
    broadcast: (_channel, event, args) => {
      if (event !== "prompt") return;
      prompts.push(args);
      void manager.cancelEditor({ promptId: (args as { promptId: string }).promptId });
    },
  });
  try {
    const filePath = path.join(dir, "COMMIT_EDITMSG");
    await writeFile(filePath, "commit message");
    const connection = new AbortController();
    const request = manager.handleHelperRequest(
      { route: "editor.open", token: "fixture", filePath },
      { signal: connection.signal },
    );
    connection.abort();
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("disconnected"),
    });
    expect(prompts).toEqual([]);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
