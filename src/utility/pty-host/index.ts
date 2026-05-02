// PTY host entry — runs in Electron utilityProcess (Node.js context).
// The main process creates a MessageChannelMain and sends one end to this
// process via process.parentPort. All PTY traffic flows over that port.

import { PtyManager } from "./ptyManager";

const manager = new PtyManager();

// process.parentPort is the Electron utility process API for receiving messages
// from the main process. Type it loosely so we can compile without electron types
// being in scope (utility tsconfig has node types only).
//
// IMPORTANT: Electron's MessageEvent shape — transferred ports arrive in
// event.ports[], NOT in event.data. See Electron docs / VSCode sharedProcessMain
// line 582: `const port = e.ports.at(0)`.
const parentPort = (
  process as unknown as {
    parentPort: {
      on: (event: "message", handler: (e: { data: unknown; ports: unknown[] }) => void) => void;
      postMessage: (data: unknown) => void;
    };
  }
).parentPort;

if (!parentPort) {
  console.error("[pty-host] no parentPort — must be started as utilityProcess");
  process.exit(1);
}

// The main process transfers a MessagePort via proc.postMessage({type:'port'}, [p2]).
// Electron places transferred ports in event.ports[], not event.data.
parentPort.on("message", (event) => {
  const msg = event.data as { type: string };
  if (msg.type === "port") {
    const port = event.ports[0] as Parameters<PtyManager["attachPort"]>[0];
    if (!port) {
      console.error("[pty-host] 'port' message received but event.ports[0] is undefined");
      return;
    }
    manager.attachPort(port);
  }
});

process.on("beforeExit", () => {
  manager.killAll();
});
