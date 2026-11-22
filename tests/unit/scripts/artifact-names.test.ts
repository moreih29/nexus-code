import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getConfig } from "app-builder-lib/out/util/config/config.js";
import { parse } from "yaml";

/**
 * The release file names electron-builder.yml gives. The site links the
 * installers as releases/latest/download/<name>, so their names must not
 * change from one release to the next.
 */

interface Config {
  productName: string;
  artifactName: string;
  dmg: { artifactName: string };
  [target: string]: unknown;
}

const projectDir = path.join(import.meta.dir, "..", "..", "..");
const config = parse(readFileSync(path.join(projectDir, "electron-builder.yml"), "utf8")) as Config;

/** A target's name pattern: its own, else the top-level one, as electron-builder picks. */
function pattern(target: string): string {
  const own = (config[target] as { artifactName?: string } | undefined)?.artifactName;
  return own ?? config.artifactName;
}

/** `target`'s file name, with `arch` spelled as electron-builder spells it for the format. */
function fileName(target: string, ext: string, arch: string): string {
  const macros: Record<string, string> = {
    productName: config.productName,
    version: "1.2.3",
    arch,
    ext,
  };
  return pattern(target).replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const value = macros[name];
    if (value === undefined) throw new Error(`unexpected macro ${name} in ${pattern(target)}`);
    return value;
  });
}

describe("release file names", () => {
  test("the installers people download carry no version", () => {
    expect([
      fileName("dmg", "dmg", "arm64"),
      fileName("appImage", "AppImage", "x86_64"),
      fileName("appImage", "AppImage", "arm64"),
      fileName("deb", "deb", "amd64"),
      fileName("deb", "deb", "arm64"),
    ]).toEqual([
      "NexusCode-arm64.dmg",
      "NexusCode-x86_64.AppImage",
      "NexusCode-arm64.AppImage",
      "NexusCode-amd64.deb",
      "NexusCode-arm64.deb",
    ]);
  });

  test("the Developer ID config keeps the unversioned DMG name", async () => {
    const configPath = path.join("build", "electron-builder.developer-id.cjs");
    const configModule = require.resolve(path.join(projectDir, configPath));
    const originalModule = require.cache[configModule];
    const tempDir = mkdtempSync(path.join(tmpdir(), "nexus-developer-id-"));
    const keyPath = path.join(tempDir, "AuthKey.p8");
    const testEnv = {
      NEXUS_MAC_DEVELOPER_ID_IDENTITY: "A".repeat(40),
      APPLE_API_KEY: keyPath,
      APPLE_API_KEY_ID: "test-key-id",
      APPLE_API_ISSUER: "test-issuer",
      APPLE_ID: undefined,
      APPLE_APP_SPECIFIC_PASSWORD: undefined,
    };
    const originalEnv = Object.keys(testEnv).map((key) => [key, process.env[key]] as const);

    try {
      writeFileSync(keyPath, "");
      for (const [key, value] of Object.entries(testEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // electron-builder requires the config, which reads the environment at load time.
      delete require.cache[configModule];
      const merged = await getConfig(projectDir, configPath, null);

      expect(merged.dmg).toMatchObject({
        artifactName: config.dmg.artifactName,
        writeUpdateInfo: false,
        sign: true,
      });
      expect(merged.artifactName).toBe(config.artifactName);
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (originalModule === undefined) delete require.cache[configModule];
      else require.cache[configModule] = originalModule;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // The macOS update finds the running version's zip blockmap by its version
  // in the name, and scripts/store-submit.ts picks the AppX by its version.
  test("the mac zip and the Store appx keep their versioned names", () => {
    expect(fileName("zip", "zip", "arm64")).toBe("NexusCode-1.2.3-arm64.zip");
    expect(fileName("appx", "appx", "x64")).toBe("NexusCode-1.2.3-x64.appx");
  });
});
