/**
 * The rule that lets a Codex manager run `nexus` outside Codex's sandbox,
 * which denies its socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MANAGER_CODEX_RULES,
  writeManagerCodexRules,
} from "../../../../../src/main/features/manager/codex-rules";

const dirs: string[] = [];

async function managerDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nexus-manager-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeManagerCodexRules", () => {
  test("allows nexus in the folder's project rules", async () => {
    const dir = await managerDir();
    await writeManagerCodexRules(dir);
    const rules = await readFile(path.join(dir, ".codex", "rules", "nexus.rules"), "utf8");
    expect(rules).toBe(MANAGER_CODEX_RULES);
    expect(rules).toContain('prefix_rule(pattern = ["nexus"], decision = "allow")');
  });

  test("puts back rules that were changed, and leaves them be when they are as written", async () => {
    const dir = await managerDir();
    const file = path.join(dir, ".codex", "rules", "nexus.rules");
    await writeManagerCodexRules(dir);
    await writeFile(file, 'prefix_rule(pattern = ["nexus"], decision = "forbidden")\n');
    await writeManagerCodexRules(dir);
    expect(await readFile(file, "utf8")).toBe(MANAGER_CODEX_RULES);

    const written = (await stat(file)).mtimeMs;
    await writeManagerCodexRules(dir);
    expect((await stat(file)).mtimeMs).toBe(written);
  });
});
