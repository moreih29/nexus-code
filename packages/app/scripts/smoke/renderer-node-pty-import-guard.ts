import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import {
  RENDERER_NODE_PTY_BLOCK_ALIAS,
  RENDERER_NODE_PTY_BLOCK_MESSAGE,
  rendererNodePtyImportGuardPlugin,
} from "../../electron.vite.config";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-renderer-node-pty-guard-"));
let blockedImportWasDetected = false;

try {
  await writeFile(
    path.join(tempRoot, "index.html"),
    "<!doctype html><html><body><script type=\"module\" src=\"./main.ts\"></script></body></html>",
  );
  await writeFile(path.join(tempRoot, "main.ts"), "import \"node-pty\";\n");

  try {
    await build({
      configFile: false,
      logLevel: "silent",
      root: tempRoot,
      resolve: {
        alias: [
          {
            find: /^node-pty$/,
            replacement: RENDERER_NODE_PTY_BLOCK_ALIAS,
          },
        ],
      },
      plugins: [rendererNodePtyImportGuardPlugin()],
      build: {
        outDir: path.join(tempRoot, "dist"),
        emptyOutDir: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    if (message.includes(RENDERER_NODE_PTY_BLOCK_MESSAGE)) {
      blockedImportWasDetected = true;
    } else {
      throw error;
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

if (!blockedImportWasDetected) {
  throw new Error("Expected renderer build to fail when importing node-pty.");
}

console.log("renderer node-pty guard smoke passed");
