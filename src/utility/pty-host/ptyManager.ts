// PTY manager — owns one node-pty IPty per tab.
// Runs inside the utility process; communicates with the main process via
// parentPort (MessagePort set up by ptyHost.ts in the main process).

import type { MessagePortMain } from "electron";
import { FlowController } from "./flowControl";
import { TerminalRecorder } from "./terminalRecorder";

// node-pty is required at runtime — it must not be bundled by Vite.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty") as typeof import("node-pty");

interface TabState {
  pty: import("node-pty").IPty;
  flow: FlowController;
  recorder: TerminalRecorder;
}

// Inbound message shapes (main → utility)
interface SpawnMsg {
  type: "spawn";
  tabId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}
interface WriteMsg {
  type: "write";
  tabId: string;
  data: string;
}
interface ResizeMsg {
  type: "resize";
  tabId: string;
  cols: number;
  rows: number;
}
interface AckMsg {
  type: "ack";
  tabId: string;
  charCount: number;
}
interface KillMsg {
  type: "kill";
  tabId: string;
}

type InboundMsg = SpawnMsg | WriteMsg | ResizeMsg | AckMsg | KillMsg;

export class PtyManager {
  private tabs = new Map<string, TabState>();
  private port: MessagePortMain | null = null;

  // Attach the MessagePort that connects to the main process.
  // All outbound events are sent via this port.
  attachPort(port: MessagePortMain): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  private send(msg: unknown): void {
    if (this.port) {
      this.port.postMessage(msg);
    }
  }

  private handleMessage(msg: InboundMsg): void {
    switch (msg.type) {
      case "spawn":
        this.spawn(msg.tabId, msg.cwd, msg.shell, msg.cols, msg.rows);
        break;
      case "write":
        this.write(msg.tabId, msg.data);
        break;
      case "resize":
        this.resize(msg.tabId, msg.cols, msg.rows);
        break;
      case "ack":
        this.ack(msg.tabId, msg.charCount);
        break;
      case "kill":
        this.kill(msg.tabId);
        break;
    }
  }

  spawn(tabId: string, cwd: string, shell: string, cols: number, rows: number): void {
    if (this.tabs.has(tabId)) {
      return;
    }

    let proc: import("node-pty").IPty;
    try {
      proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch {
      this.send({ type: "exit", tabId, code: 1, signal: undefined });
      return;
    }

    const flow = new FlowController();
    const recorder = new TerminalRecorder(cols, rows);

    const state: TabState = { pty: proc, flow, recorder };
    this.tabs.set(tabId, state);

    proc.onData((data: string) => {
      recorder.handleData(data);
      const shouldPause = flow.onData(data.length);
      this.send({ type: "data", tabId, chunk: data });
      if (shouldPause) {
        proc.pause();
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      this.tabs.delete(tabId);
      this.send({ type: "exit", tabId, code: exitCode ?? null, signal: signal ?? undefined });
    });

    this.send({ type: "spawned", tabId, pid: proc.pid });
  }

  write(tabId: string, data: string): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.pty.write(data);
    }
  }

  resize(tabId: string, cols: number, rows: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.pty.resize(cols, rows);
      state.recorder.handleResize(cols, rows);
    }
  }

  ack(tabId: string, charCount: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      const shouldResume = state.flow.onAck(charCount);
      if (shouldResume) {
        state.pty.resume();
      }
    }
  }

  kill(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (state) {
      this.tabs.delete(tabId);
      try {
        state.pty.kill();
      } catch {
        // ignore — process may have already exited
      }
    }
  }

  killAll(): void {
    for (const tabId of this.tabs.keys()) {
      this.kill(tabId);
    }
  }
}
