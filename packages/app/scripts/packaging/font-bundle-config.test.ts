import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_ROOT = resolve(import.meta.dir, "../..");

describe("font bundle packaging config", () => {
  test("electron-builder ships bundled fonts as extraResources", () => {
    const builderConfigPath = resolve(APP_ROOT, "electron-builder.yml");
    const builderConfig = readFileSync(builderConfigPath, "utf8");

    expect(builderConfig).toContain("- from: assets/fonts/");
    expect(builderConfig).toContain("to: fonts");
    expect(builderConfig).toContain('- "**/*"');
  });

  test("font binaries and OFL licenses exist under assets/fonts", () => {
    const requiredFiles = [
      "assets/fonts/d2coding/D2Coding-Ver1.3.2-20180524.ttf",
      "assets/fonts/d2coding/D2CodingBold-Ver1.3.2-20180524.ttf",
      "assets/fonts/d2coding/OFL.txt",
      "assets/fonts/noto-sans-kr/NotoSansKR[wght].ttf",
      "assets/fonts/noto-sans-kr/OFL.txt",
    ];

    for (const requiredFile of requiredFiles) {
      const absolutePath = resolve(APP_ROOT, requiredFile);
      expect(existsSync(absolutePath)).toBeTrue();
    }

    const d2CodingLicense = readFileSync(resolve(APP_ROOT, "assets/fonts/d2coding/OFL.txt"), "utf8");
    const notoSansKrLicense = readFileSync(resolve(APP_ROOT, "assets/fonts/noto-sans-kr/OFL.txt"), "utf8");

    expect(d2CodingLicense).toContain("SIL OPEN FONT LICENSE");
    expect(notoSansKrLicense).toContain("SIL OPEN FONT LICENSE");
  });
});
