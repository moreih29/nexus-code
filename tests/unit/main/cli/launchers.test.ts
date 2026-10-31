/**
 * The Windows nexus command: nexus.exe copied out beside Git Bash's script,
 * and that script, which keeps Git Bash's hands off the arguments.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWindowsCli } from "../../../../src/main/features/cli/launchers";
import { windowsGitBashLauncher } from "../../../../src/shared/cli/launcher";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-launchers-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, text: string, mode = 0o644): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  return file;
}

describe("writeWindowsCli", () => {
  function agentBuilt(version: string): string {
    const dist = path.join(tmp, "dist");
    write(path.join(dist, `nexus-${version}-windows-amd64.exe`), `nexus ${version}`);
    return write(path.join(dist, `agent-${version}-windows-amd64.exe`), `agent ${version}`);
  }

  test("copies nexus.exe and writes Git Bash's script in both directories", () => {
    const cli = path.join(tmp, "cli");
    const wrapper = path.join(tmp, "bin");
    writeWindowsCli(agentBuilt("1.0.0"), cli, wrapper);

    expect(fs.readFileSync(path.join(cli, "nexus.exe"), "utf8")).toBe("nexus 1.0.0");
    const script = windowsGitBashLauncher(path.join(cli, "nexus.exe"));
    expect(fs.readFileSync(path.join(cli, "nexus"), "utf8")).toBe(script);
    expect(fs.readFileSync(path.join(wrapper, "nexus"), "utf8")).toBe(script);
  });

  test("replaces an older nexus.exe and the .cmd launcher before it", () => {
    const cli = path.join(tmp, "cli");
    write(path.join(cli, "nexus.exe"), "nexus 0.9.0");
    write(path.join(cli, "nexus.cmd"), "@echo off");
    write(path.join(cli, "nexus.exe.1-2.old"), "moved aside while it ran");
    writeWindowsCli(agentBuilt("1.0.0"), cli, path.join(tmp, "bin"));

    expect(fs.readFileSync(path.join(cli, "nexus.exe"), "utf8")).toBe("nexus 1.0.0");
    expect(fs.readdirSync(cli).sort()).toEqual(["nexus", "nexus.exe"]);
  });

  test("fails when the build has no nexus.exe", () => {
    const agent = write(path.join(tmp, "dist", "agent-1.0.0-windows-amd64.exe"), "agent");
    expect(() => writeWindowsCli(agent, path.join(tmp, "cli"), path.join(tmp, "bin"))).toThrow();
  });
});

// The launcher is tested under sh where there is one, with a fake cygpath,
// and in Git Bash itself on Windows.
const describeOnPosix = describe.skipIf(process.platform === "win32");
const GIT_BASH = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Git",
  "bin",
  "bash.exe",
);
const describeInGitBash = describe.skipIf(process.platform !== "win32" || !fs.existsSync(GIT_BASH));

describeOnPosix("Git Bash's launcher", () => {
  // Prints what nexus.exe would be handed: the variables, then each argument.
  function program(dir: string): string {
    return write(
      path.join(dir, "nexus.exe"),
      [
        "#!/bin/sh",
        'case "$(export -p)" in *NEXUS_MSYS_ROOT=*) set=yes ;; *) set=no ;; esac',
        'printf "root=%s set=%s\\n" "$NEXUS_MSYS_ROOT" "$set"',
        'printf "pathconv=%s excl=%s\\n" "$MSYS_NO_PATHCONV" "$MSYS2_ARG_CONV_EXCL"',
        'for arg in "$@"; do printf "<%s>\\n" "$arg"; done',
        "",
      ].join("\n"),
      0o755,
    );
  }

  function run(launcherDir: string, pathDirs: string[], args: string[]) {
    const launcher = write(
      path.join(launcherDir, "nexus"),
      windowsGitBashLauncher(program(launcherDir)),
      0o755,
    );
    return spawnSync("/bin/sh", [launcher, ...args], {
      env: { PATH: pathDirs.join(path.delimiter) },
      encoding: "utf8",
    });
  }

  test("hands the arguments over untouched, with where / is", () => {
    const fakeBin = path.join(tmp, "fake-bin");
    write(
      path.join(fakeBin, "cygpath"),
      "#!/bin/sh\nprintf '%s\\n' 'C:\\Program Files\\Git\\'\n",
      0o755,
    );
    // A quote in the program's path survives the script's quoting.
    const result = run(path.join(tmp, "it's here"), [fakeBin], ["/review", "a b", "it's"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "root=C:\\Program Files\\Git\\ set=yes",
        "pathconv=1 excl=*",
        "</review>",
        "<a b>",
        "<it's>",
        "",
      ].join("\n"),
    );
  });

  test("says / is unknown, quietly, without cygpath", () => {
    const result = run(path.join(tmp, "cli"), [path.join(tmp, "empty")], ["status"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toStartWith("root= set=yes\npathconv=1 excl=*\n<status>\n");
  });
});

describeInGitBash("Git Bash's launcher in Git Bash", () => {
  test("keeps Git Bash from rewriting the arguments, and says where / is", () => {
    // The program is this one, a Windows program, as nexus.exe is.
    const launcher = write(path.join(tmp, "nexus"), windowsGitBashLauncher(process.execPath));
    const code =
      "console.log(JSON.stringify({ argv: process.argv, root: process.env.NEXUS_MSYS_ROOT }))";
    const result = spawnSync(GIT_BASH, [launcher, "-e", code, "/review", "/c/src", "a b"], {
      encoding: "utf8",
      timeout: 20000,
    });

    expect(result.status).toBe(0);
    const { argv, root } = JSON.parse(result.stdout) as { argv: string[]; root: string };
    expect(argv.slice(-3)).toEqual(["/review", "/c/src", "a b"]);
    expect(root).toMatch(/^[A-Za-z]:\\.*Git\\?$/);
  });
});
