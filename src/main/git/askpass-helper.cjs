#!/usr/bin/env node
/**
 * Git askpass helper.
 *
 * Git invokes this script with the prompt text as argv. The script forwards
 * the prompt to the main-process helper socket and writes the renderer's
 * answer to stdout so Git can consume it as the credential value.
 */
const net = require("node:net");

/** Writes an error message and exits with Git's askpass failure code. */
function fail(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Reads required connection values from the environment. */
function readConnectionEnv() {
  const socketPath = process.env.NEXUS_HELPERS_SOCKET;
  const token = process.env.NEXUS_HELPERS_TOKEN;
  if (!socketPath || !token) {
    fail("Nexus Git askpass helper missing socket or token.");
  }
  return { socketPath, token };
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
        reject(new Error("Nexus Git askpass helper received no response."));
      }
    });
  });
}

/** Runs the askpass request and maps manager cancellation to exit code 1. */
async function main() {
  const { socketPath, token } = readConnectionEnv();
  const prompt = process.argv.slice(2).join(" ");
  const response = await sendHelperRequest(socketPath, {
    route: "askpass.prompt",
    token,
    prompt,
    workspaceId: process.env.NEXUS_HELPERS_WORKSPACE_ID,
  });

  if (!response || response.ok !== true) {
    fail(response?.error ? response.error : "Nexus Git credential prompt cancelled.");
  }

  process.stdout.write(String(response.value ?? ""));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
