import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * The release file names electron-builder.yml gives. The site links the
 * installers as releases/latest/download/<name>, so their names must not
 * change from one release to the next.
 */

interface Config {
  productName: string;
  artifactName: string;
  [target: string]: unknown;
}

const config = parse(
  readFileSync(path.join(import.meta.dir, "../../../electron-builder.yml"), "utf8"),
) as Config;

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

  // The macOS update finds the running version's zip blockmap by its version
  // in the name, and scripts/store-submit.ts picks the AppX by its version.
  test("the mac zip and the Store appx keep their versioned names", () => {
    expect(fileName("zip", "zip", "arm64")).toBe("NexusCode-1.2.3-arm64.zip");
    expect(fileName("appx", "appx", "x64")).toBe("NexusCode-1.2.3-x64.appx");
  });
});
