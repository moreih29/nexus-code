#!/usr/bin/env node
/**
 * Git editor helper.
 *
 * Git invokes this script with the temporary commit-message file path. The
 * script asks the main process to open the renderer editor dialog and exits
 * zero only when the renderer saves the message.
 */
const net = require("node:net");

/** Writes an error message and exits with Git's editor failure code. */
function fail(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Reads required connection values and Git's temporary file argument. */
function readEditorRequest() {
  const socketPath = process.env.NEXUS_HELPERS_SOCKET;
  const token = process.env.NEXUS_HELPERS_TOKEN;
  const filePath = process.argv[2];
  if (!socketPath || !token) {
    fail("Nexus Git editor helper missing socket or token.");
  }
  if (!filePath) {
    fail("Nexus Git editor helper missing commit message file.");
  }
  return { socketPath, token, filePath };
}

/** Sends one JSON-line request to the helper manager and resolves its reply. */
function sendHelperRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (buffer.trim().length === 0) {
        reject(new Error("Nexus Git editor helper received no response."));
      }
    });
  });
}

/** Runs the editor request and maps cancellation to exit code 1. */
async function main() {
  const { socketPath, token, filePath } = readEditorRequest();
  const response = await sendHelperRequest(socketPath, {
    route: "editor.open",
    token,
    filePath,
    workspaceId: process.env.NEXUS_HELPERS_WORKSPACE_ID,
  });

  if (!response || response.ok !== true) {
    fail(response?.error ? response.error : "Nexus Git commit editor cancelled.");
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
