// Shared bootstrap for Electron utilityProcess entry points.
// Handles parentPort acquisition, port-handshake, and beforeExit teardown
// so each host entry only needs to supply its manager factory and teardown.

type ParentPort = {
  on: (event: "message", handler: (e: { data: unknown; ports: unknown[] }) => void) => void;
  postMessage: (data: unknown) => void;
};

interface UtilityProcessEntryOptions {
  /** Short tag used in error log lines, e.g. "[lsp-host]". */
  logPrefix: string;
  /**
   * Called with the transferred MessagePort once the main process sends the
   * "port" handshake message. Should attach the port to the manager and return
   * the manager instance (used only to drive teardown).
   */
  managerFactory: (port: unknown) => { teardown: () => void };
}

export function createUtilityProcessEntry(opts: UtilityProcessEntryOptions): void {
  const { logPrefix, managerFactory } = opts;

  const parentPort = (
    process as unknown as { parentPort: ParentPort | undefined }
  ).parentPort;

  if (!parentPort) {
    console.error(`${logPrefix} no parentPort — must be started as utilityProcess`);
    process.exit(1);
  }

  let manager: { teardown: () => void } | null = null;

  parentPort.on("message", (event) => {
    const msg = event.data as { type: string };
    if (msg.type === "port") {
      const port = event.ports[0];
      if (!port) {
        console.error(`${logPrefix} 'port' message received but event.ports[0] is undefined`);
        return;
      }
      manager = managerFactory(port);
    }
  });

  process.on("beforeExit", () => {
    manager?.teardown();
  });
}
