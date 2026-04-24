import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ShellEnvironmentCapture,
  ShellEnvironmentResolver,
} from "./shell-environment-resolver";

const MAIN_SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

describe("ShellEnvironmentResolver", () => {
  test("captures login shell environment, sanitizes malformed entries, and applies defaults", async () => {
    const processEnv: NodeJS.ProcessEnv = {
      SHELL: "/bin/bash",
      PATH: "/usr/bin:/bin",
      FROM_PROCESS: "yes",
      LANG: "ko_KR.UTF-8",
      TERM: "dumb",
      COLORTERM: "8bit",
    };
    processEnv[""] = "invalid-empty-key";

    let captureCalls = 0;
    const captureEnvironment: ShellEnvironmentCapture = async ({
      shellPath,
      shellArgs,
      timeoutMs,
    }) => {
      captureCalls += 1;
      expect(shellPath).toBe("/bin/bash");
      expect(shellArgs).toEqual(["-l", "-i", "-c", "env"]);
      expect(timeoutMs).toBe(5_000);
      return {
        status: "ok",
        stdout: [
          "PATH=/opt/homebrew/bin:/usr/bin",
          "FROM_CAPTURE=yes",
          "WITH_EQUALS=left=right=value",
          "MALFORMED_LINE",
          "=missing_key",
          "SHELL=/opt/homebrew/bin/zsh",
          "LANG=ja_JP.UTF-8",
          "LC_ALL=de_DE.UTF-8",
          "",
        ].join("\n"),
      };
    };

    const resolver = new ShellEnvironmentResolver({
      processEnv,
      captureEnvironment,
    });

    const baseEnv = await resolver.getBaseEnv();

    expect(captureCalls).toBe(1);
    expect(baseEnv.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(baseEnv.FROM_PROCESS).toBe("yes");
    expect(baseEnv.FROM_CAPTURE).toBe("yes");
    expect(baseEnv.WITH_EQUALS).toBe("left=right=value");
    expect(baseEnv.MALFORMED_LINE).toBeUndefined();
    expect(baseEnv[""]).toBeUndefined();

    expect(baseEnv.TERM).toBe("xterm-256color");
    expect(baseEnv.COLORTERM).toBe("truecolor");
    expect(baseEnv.LANG).toBe("ja_JP.UTF-8");
    expect(baseEnv.LC_ALL).toBe("de_DE.UTF-8");

    expect(resolver.getDefaultShell()).toBe("/opt/homebrew/bin/zsh");
  });

  test("falls back to process.env on capture timeout and logs in dev seam", async () => {
    const logs: Array<{ message: string; error?: unknown }> = [];
    const resolver = new ShellEnvironmentResolver({
      processEnv: {
        PATH: "/usr/local/bin:/usr/bin",
        SHELL: "/bin/fish",
      },
      captureEnvironment: async () => ({ status: "timeout" }),
      onDevLog: (message, error) => {
        logs.push({ message, error });
      },
    });

    const baseEnv = await resolver.getBaseEnv();

    expect(baseEnv.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(baseEnv.TERM).toBe("xterm-256color");
    expect(baseEnv.COLORTERM).toBe("truecolor");
    expect(baseEnv.LANG).toBe("en_US.UTF-8");
    expect(baseEnv.LC_ALL).toBe("en_US.UTF-8");
    expect(resolver.getDefaultShell()).toBe("/bin/fish");

    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain("timed out after 5000ms");
    expect(logs[0]!.error).toBeUndefined();
  });

  test("defaults shell to /bin/zsh and default args to login interactive flags", () => {
    const resolver = new ShellEnvironmentResolver({
      processEnv: {},
      captureEnvironment: async () => ({ status: "timeout" }),
    });

    expect(resolver.getDefaultShell()).toBe("/bin/zsh");
    expect(resolver.getDefaultShellArgs()).toEqual(["-l", "-i"]);
  });

  test("caches base environment and reuses in-flight capture without real shell spawn", async () => {
    let captureCalls = 0;
    const resolver = new ShellEnvironmentResolver({
      processEnv: {
        PATH: "/usr/bin",
      },
      captureEnvironment: async () => {
        captureCalls += 1;
        return {
          status: "ok",
          stdout: "CAPTURED=once\n",
        };
      },
    });

    const [first, second] = await Promise.all([resolver.getBaseEnv(), resolver.getBaseEnv()]);
    expect(captureCalls).toBe(1);
    expect(first.CAPTURED).toBe("once");
    expect(second.CAPTURED).toBe("once");

    first.CAPTURED = "mutated";
    const third = await resolver.getBaseEnv();
    expect(third.CAPTURED).toBe("once");
    expect(captureCalls).toBe(1);
  });

  test("renderer runtime sources do not import main-only shell resolver modules", async () => {
    const rendererDirectory = path.resolve(MAIN_SOURCE_DIRECTORY, "../renderer");
    const rendererFiles = await listRendererTypeScriptFiles(rendererDirectory);

    expect(rendererFiles.length).toBeGreaterThan(0);

    for (const rendererFile of rendererFiles) {
      const source = await readFile(rendererFile, "utf8");
      expect(source).not.toMatch(/shell-environment-resolver/u);
    }
  });
});

async function listRendererTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRendererTypeScriptFiles(entryPath)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(entryPath);
    }
  }

  return files;
}
