import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import {
  buildSshMuxForwardArgs,
  buildSshOwnForwardArgs,
  openSshTunnel,
} from "../../../../src/main/infra/agent/ssh/forward";

const TARGET = { host: "devbox", user: "dev", port: 2222, identityFile: "/k/id" };

/** An ssh child the test drives: what it prints and when it exits. */
class FakeSsh extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  constructor(readonly args: string[]) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }

  exit(code: number | null, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    // Let the stderr data land first, as a real process's would.
    setTimeout(() => this.emit("close", code), 0);
  }
}

function fakeSpawn(onSpawn: (child: FakeSsh) => void) {
  const spawned: FakeSsh[] = [];
  const spawn = (_command: string, args: string[]) => {
    const child = new FakeSsh(args);
    spawned.push(child);
    onSpawn(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, spawned };
}

describe("ssh forward arguments", () => {
  test("a ControlMaster forwards 127.0.0.1 here to the host's localhost", () => {
    expect(
      buildSshMuxForwardArgs({ ...TARGET, controlPath: "/tmp/c.sock" }, "forward", 5174, 5173),
    ).toEqual([
      "-S",
      "/tmp/c.sock",
      "-O",
      "forward",
      "-L",
      "127.0.0.1:5174:localhost:5173",
      "-p",
      "2222",
      "-i",
      "/k/id",
      "--",
      "dev@devbox",
    ]);
  });

  test("an ssh of its own asks nothing, fails on a port it cannot bind, and waits on stdin", () => {
    const args = buildSshOwnForwardArgs({ host: "devbox" }, 3000, 3000);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.slice(args.indexOf("-L"), args.indexOf("-L") + 2)).toEqual([
      "-L",
      "127.0.0.1:3000:localhost:3000",
    ]);
    expect(args.slice(-3)).toEqual([
      "--",
      "devbox",
      "echo nexus-forward-ready; exec cat >/dev/null",
    ]);
  });
});

describe("openSshTunnel over OpenSSH", () => {
  test("a ControlMaster forwards, and cancels the forward on close", async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.exit(0));
    const tunnel = await openSshTunnel({ ...TARGET, controlPath: "/tmp/c.sock" }, 5173, 5173, {
      spawn,
      ssh2: false,
    });
    expect(spawned[0].args.slice(0, 4)).toEqual(["-S", "/tmp/c.sock", "-O", "forward"]);
    expect(tunnel).toMatchObject({ localPort: 5173, remotePort: 5173, controlPath: "/tmp/c.sock" });
    expect(tunnel.alive()).toBe(true);

    await tunnel.close();
    await tunnel.closed;
    expect(spawned[1].args.slice(0, 4)).toEqual(["-S", "/tmp/c.sock", "-O", "cancel"]);
    expect(tunnel.alive()).toBe(false);
  });

  test("a forward the master refuses fails with ssh's words", async () => {
    const { spawn } = fakeSpawn((child) =>
      child.exit(255, "mux_client_forward: forwarding request failed: Port forwarding failed\n"),
    );
    await expect(
      openSshTunnel({ ...TARGET, controlPath: "/tmp/c.sock" }, 5173, 5173, { spawn, ssh2: false }),
    ).rejects.toThrow("mux_client_forward: forwarding request failed: Port forwarding failed");
  });

  test("without a master, an ssh of its own forwards once it says it is ready", async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.stdout.write("nexus-forward-ready\n"));
    const tunnel = await openSshTunnel({ host: "devbox" }, 3001, 3000, { spawn, ssh2: false });
    expect(tunnel).toMatchObject({ localPort: 3001, remotePort: 3000, controlPath: undefined });
    expect(tunnel.alive()).toBe(true);

    // It ends on its own when its connection drops.
    spawned[0].exit(255);
    await tunnel.closed;
    expect(tunnel.alive()).toBe(false);
  });

  test("an ssh of its own that exits before it is ready fails with its last word", async () => {
    const { spawn } = fakeSpawn((child) =>
      child.exit(
        255,
        "bind [127.0.0.1]:3000: Address already in use\nCould not request local forwarding.\n",
      ),
    );
    await expect(
      openSshTunnel({ host: "devbox" }, 3000, 3000, { spawn, ssh2: false }),
    ).rejects.toThrow("Could not request local forwarding.");
  });

  test("closing an ssh of its own ends its stdin and stops it", async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.stdout.write("nexus-forward-ready\n"));
    const tunnel = await openSshTunnel({ host: "devbox" }, 3000, 3000, { spawn, ssh2: false });
    await tunnel.close();
    expect(spawned[0].killed).toBe(true);
    expect(spawned[0].stdin.writableEnded).toBe(true);
  });
});

/** A free port here, found by listening on port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** One end of a channel whose far end echoes what it is sent, upper-cased. */
function echoChannel(): Duplex {
  const channel: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      channel.push(chunk.toString("utf8").toUpperCase());
      done();
    },
  });
  return channel;
}

describe("openSshTunnel over ssh2", () => {
  test("each connection here gets a channel to the host's localhost port", async () => {
    const opened: Array<[string, number]> = [];
    let disposed = false;
    const localPort = await freePort();
    const tunnel = await openSshTunnel(
      { ...TARGET, controlPath: "ssh2:1:dev@devbox" },
      localPort,
      5173,
      {
        ssh2: true,
        createSsh2Forwarder: (_target, controlPath) => {
          expect(controlPath).toBe("ssh2:1:dev@devbox");
          return {
            async open(host, port) {
              opened.push([host, port]);
              return echoChannel();
            },
            dispose() {
              disposed = true;
            },
          };
        },
      },
    );

    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(localPort, "127.0.0.1", () => socket.write("ping"));
      socket.once("data", (data) => {
        resolve(data.toString("utf8"));
        socket.destroy();
      });
      socket.once("error", reject);
    });
    expect(answer).toBe("PING");
    expect(opened).toEqual([["localhost", 5173]]);

    await tunnel.close();
    await tunnel.closed;
    expect(disposed).toBe(true);
    expect(tunnel.alive()).toBe(false);
    // The port is free again.
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", () => server.close(() => resolve()));
    });
  });

  test("a port taken here fails the forward and closes its connection", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
    const { port } = taken.address() as net.AddressInfo;
    let disposed = false;
    try {
      await expect(
        openSshTunnel({ host: "devbox" }, port, 5173, {
          ssh2: true,
          createSsh2Forwarder: () => ({
            open: async () => echoChannel(),
            dispose() {
              disposed = true;
            },
          }),
        }),
      ).rejects.toThrow();
      expect(disposed).toBe(true);
    } finally {
      taken.close();
    }
  });
});
