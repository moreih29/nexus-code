import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GitHelpersIpcManager } from "../../../../../../../src/main/features/git/domain/helpers/ipc";

test("stopping Git helpers also closes an accepted client that sent no request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-helper-shutdown-"));
  const manager = new GitHelpersIpcManager({ userDataDir: dir, broadcast: () => {} });
  try {
    const endpoint = await manager.start();
    const server = (manager as unknown as { server: net.Server }).server;
    const arrival = once(server, "connection");
    const client = net.createConnection(endpoint.socketPath);
    client.on("error", () => {});
    const [socket] = (await arrival) as [net.Socket];
    const dispose = manager.dispose();
    try {
      expect(socket.destroyed).toBe(true);
      await dispose;
    } finally {
      client.destroy();
      await dispose;
    }
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
