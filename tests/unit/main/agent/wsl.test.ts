import { describe, expect, jest, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createWslBootstrapRunner,
  decodeWslOutput,
  listWslDistros,
  parseWslDistros,
  runWslExe,
} from "../../../../src/main/infra/agent/wsl";

/** A wsl.exe fixture that never reports close unless terminated. */
function stalledChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const kill = mock(() => true);
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
  });
  return { child, kill };
}

/** A child that prints `stdout`/`stderr`, then exits with `code`, once stdin ends. */
function fakeChild(result: { stdout?: string; stderr?: Buffer | string; code: number }) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { input: Buffer[] };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  child.input = [];
  stdin.on("data", (chunk: Buffer) => child.input.push(chunk));
  stdin.on("finish", () => {
    stdout.end(result.stdout ?? "");
    stderr.end(result.stderr ?? "");
    setImmediate(() => child.emit("close", result.code));
  });
  Object.assign(child, { stdout, stderr, stdin });
  return child;
}

describe("createWslBootstrapRunner", () => {
  test("runs the command an ssh step carries under sh -c in the distribution", async () => {
    const child = fakeChild({ stdout: "Linux x86_64\n", code: 0 });
    const spawn = mock((_distro: string, _argv: readonly string[]) => child);
    const run = createWslBootstrapRunner("Ubuntu", spawn);

    const result = await run(
      "ssh",
      ["-o", "BatchMode=yes", "--", "wsl:Ubuntu", "uname -ms"],
      Buffer.from("payload"),
    );

    expect(spawn).toHaveBeenCalledWith("Ubuntu", ["sh", "-c", "uname -ms"]);
    expect(result.stdout).toBe("Linux x86_64\n");
    expect(Buffer.concat(child.input).toString()).toBe("payload");
  });

  test("fails with what the distribution printed", async () => {
    const run = createWslBootstrapRunner("Ubuntu", () =>
      fakeChild({ stderr: "mkdir: Permission denied\n", code: 1 }),
    );

    const error = await run("ssh", ["--", "wsl:Ubuntu", "mkdir -p /x"]).catch((e) => e);

    expect((error as Error & { cause: Error }).cause.message).toBe("mkdir: Permission denied");
  });

  test("ends a stalled WSL bootstrap command even after stdin breaks", async () => {
    jest.useFakeTimers();
    try {
      const { child, kill } = stalledChild();
      const run = createWslBootstrapRunner("Ubuntu", () => child);
      const outcome = run("ssh", ["--", "wsl:Ubuntu", "uname -ms"], "payload").catch(
        (error: unknown) => error,
      );
      child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      jest.advanceTimersByTime(120_000);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(await outcome).toMatchObject({ code: "transport.timeout" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("refuses sftp without starting anything, so an upload falls back to cat", async () => {
    const spawn = mock(() => fakeChild({ code: 0 }));
    const run = createWslBootstrapRunner("Ubuntu", spawn);

    await expect(run("sftp", ["wsl:Ubuntu"], "put a b\n")).rejects.toThrow("sftp");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("decodeWslOutput", () => {
  test("reads UTF-8, and UTF-16LE from a wsl.exe that ignores WSL_UTF8", () => {
    expect(decodeWslOutput(Buffer.from("Ubuntu\r\n"))).toBe("Ubuntu\r\n");
    const withBom = Buffer.from(`${String.fromCharCode(0xfeff)}Ubuntu\r\n`, "utf16le");
    expect(decodeWslOutput(withBom)).toBe("Ubuntu\r\n");
  });
});

describe("WSL distributions", () => {
  test("lists each distribution but Docker Desktop's", () => {
    expect(
      parseWslDistros("Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\n Debian \r\n\r\n"),
    ).toEqual(["Ubuntu", "Debian"]);
  });

  test("ends a stalled distribution lookup and returns an empty list", async () => {
    jest.useFakeTimers();
    try {
      const { child, kill } = stalledChild();
      const listed = listWslDistros((args) => runWslExe(args, (() => child) as never), "win32");
      jest.advanceTimersByTime(10_000);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(await listed).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("asks wsl.exe on Windows only, and lists none when it fails", async () => {
    const run = mock(async (_args: readonly string[]) => Buffer.from("Ubuntu\n", "utf16le"));

    expect(await listWslDistros(run, "win32")).toEqual(["Ubuntu"]);
    expect(run).toHaveBeenCalledWith(["-l", "-q"]);
    expect(await listWslDistros(run, "darwin")).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await listWslDistros(() => Promise.reject(new Error("no WSL")), "win32")).toEqual([]);
  });
});
