import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import type { SpawnPty } from "../../../../src/main/infra/agent/ssh/ssh-auth-pty";

type PtyExitEvent = Parameters<Parameters<IPty["onExit"]>[0]>[0];

const NODE_PTY_BRIDGE_SCRIPT = String.raw`
const pty = require("node-pty");
const readline = require("node:readline");

const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
const options = JSON.parse(process.argv[3]);
const child = pty.spawn(command, args, options);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

child.onData((data) => send({ type: "data", data }));
child.onExit((event) => {
  send({ type: "exit", exitCode: event.exitCode, signal: event.signal });
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "write") child.write(message.data);
  if (message.type === "kill") child.kill(message.signal);
});
`;

/**
 * Runs node-pty inside Node for Bun-based integration tests. Bun can load the
 * native module but, in this environment, its PTY callbacks do not emit.
 */
export const spawnNodeBackedPty: SpawnPty = (command, args, options) => {
  return new NodeBackedPty(command, args, options) as unknown as IPty;
};

class NodeBackedPty {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataEmitter = new EventEmitter();
  private readonly exitEmitter = new EventEmitter();
  private stdoutBuffer = "";

  constructor(command: string, args: string[], options: Parameters<SpawnPty>[2]) {
    this.child = spawn(
      "node",
      ["-e", NODE_PTY_BRIDGE_SCRIPT, command, JSON.stringify(args), JSON.stringify(options)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.dataEmitter.emit("data", chunk.toString("utf8"));
    });
    this.child.on("exit", (code, signal) => {
      this.exitEmitter.emit("exit", { exitCode: code ?? 1, signal });
    });
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataEmitter.on("data", callback);
    return { dispose: () => this.dataEmitter.off("data", callback) };
  }

  onExit(callback: (event: PtyExitEvent) => void): { dispose(): void } {
    this.exitEmitter.on("exit", callback);
    return { dispose: () => this.exitEmitter.off("exit", callback) };
  }

  write(data: string): void {
    this.send({ type: "write", data });
  }

  kill(signal?: string): void {
    this.send({ type: "kill", signal });
    this.child.kill();
  }

  private send(message: unknown): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleBridgeLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleBridgeLine(line: string): void {
    if (line.length === 0) return;
    const message = JSON.parse(line) as
      | { type: "data"; data: string }
      | { type: "exit"; exitCode: number; signal?: number };
    if (message.type === "data") {
      this.dataEmitter.emit("data", message.data);
      return;
    }
    this.exitEmitter.emit("exit", { exitCode: message.exitCode, signal: message.signal });
  }
}
