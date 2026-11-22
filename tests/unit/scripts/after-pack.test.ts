import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Arch } from "electron-builder";

const { default: afterPack } = require("../../../build/after-pack.cjs") as {
  default(context: {
    appOutDir: string;
    arch: Arch;
    electronPlatformName: string;
    packager: { appInfo: { productFilename: string } };
  }): Promise<void>;
};

describe.skipIf(process.platform === "win32")("afterPack POSIX permissions", () => {
  test.each(["linux", "darwin"])("restores bundled %s executables", async (platform) => {
    const appOutDir = mkdtempSync(path.join(os.tmpdir(), "nexus-after-pack-"));
    const resources = path.join(
      appOutDir,
      platform === "darwin" ? "NexusCode.app/Contents/Resources" : "resources",
    );
    const executables = [
      `agent/agent-0.37.1-${platform}-arm64`,
      "agent/bin/nexus",
      "agent/bin/claude",
      "agent/bin/codex",
    ];
    const data = [
      "agent/manifest.json",
      "agent/runtime/node.tar.gz",
      "agent/lsp/server.tar.gz",
      "voice-print/model.onnx",
      `app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/${platform}/arm64/onnxruntime_binding.node`,
    ];

    try {
      for (const relativePath of [...executables, ...data]) {
        const file = path.join(resources, relativePath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "", { mode: 0o644 });
      }

      await afterPack({
        appOutDir,
        arch: Arch.arm64,
        electronPlatformName: platform,
        packager: { appInfo: { productFilename: "NexusCode" } },
      });

      for (const file of executables) {
        expect(statSync(path.join(resources, file)).mode & 0o777).toBe(0o755);
      }
      for (const file of data) {
        expect(statSync(path.join(resources, file)).mode & 0o777).toBe(0o644);
      }
    } finally {
      rmSync(appOutDir, { recursive: true, force: true });
    }
  });
});
