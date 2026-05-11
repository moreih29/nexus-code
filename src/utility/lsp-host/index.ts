// LSP host entry — runs in Electron utilityProcess (Node.js context).
// The main process creates a MessageChannelMain and sends one end to this
// process via process.parentPort. All LSP traffic flows over that port.

import { createUtilityProcessEntry } from "../utility-process-entry";
import { LspManager } from "./lsp-manager";

const manager = new LspManager();

createUtilityProcessEntry({
  logPrefix: "[lsp-host]",
  managerFactory: (port) => {
    manager.attachPort(port as Parameters<LspManager["attachPort"]>[0]);
    return { teardown: () => manager.disposeAll() };
  },
});
