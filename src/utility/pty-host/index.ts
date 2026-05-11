// PTY host entry — runs in Electron utilityProcess (Node.js context).
// The main process creates a MessageChannelMain and sends one end to this
// process via process.parentPort. All PTY traffic flows over that port.

import { createUtilityProcessEntry } from "../utility-process-entry";
import { PtyManager } from "./pty-manager";

const manager = new PtyManager();

createUtilityProcessEntry({
  logPrefix: "[pty-host]",
  managerFactory: (port) => {
    manager.attachPort(port as Parameters<PtyManager["attachPort"]>[0]);
    return { teardown: () => manager.killAll() };
  },
});
