import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPromptFiles } from "../../../../src/main/features/chat/prompt-files";

describe("prompt files", () => {
  test("write the text unchanged as UTF-8 without a BOM, sweep old files, and remove", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "nx-prompt-"));
    const dir = path.join(base, "run", "claude-prompts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.txt"), "old");
    try {
      const files = createPromptFiles(dir);
      const text = '한글 "q"  \r\n line\n';
      const file = await files.write("tab/1", text);
      expect(path.dirname(file)).toBe(dir);
      expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
      const bytes = fs.readFileSync(file);
      expect(bytes.equals(Buffer.from(text, "utf8"))).toBe(true);
      await files.remove(file);
      expect(fs.existsSync(file)).toBe(false);
      await files.remove(file);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
