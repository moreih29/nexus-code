/**
 * Unit tests for shell-shim.ts — applyShellPathShim pure function.
 *
 * Acceptance criteria:
 *  1. shell="/bin/zsh"        → ZDOTDIR=<shimDir>, NEXUS_USER_ZDOTDIR=<original or "">
 *  2. shell="zsh-5.9"         → zsh branch
 *  3. shell="/bin/bash"       → args starts with --rcfile <shimDir>/bashrc -i
 *  4. shell="/usr/local/bin/bash" → same
 *  5. shell="/usr/local/bin/fish" → no-op
 *  6. shell undefined + env.SHELL="/bin/zsh" → zsh branch
 *  7. shell undefined + env.SHELL undefined   → no-op
 *  8. zsh branch + existing args → args unchanged
 *  9. bash branch + existing args → --rcfile/-i prepended before existing args
 */

import { describe, expect, test } from "bun:test";
import { applyShellPathShim } from "../../../../src/main/features/pty/shell-shim";

const SHIM_DIR = "/home/user/.nexus-code/shim/ws-abc123";

describe("applyShellPathShim", () => {
  test("1: shell=/bin/zsh → ZDOTDIR=shimDir, NEXUS_USER_ZDOTDIR=original ZDOTDIR", () => {
    const input = {
      shell: "/bin/zsh",
      env: { ZDOTDIR: "/home/user/.config/zsh", PATH: "/usr/bin" },
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env.ZDOTDIR).toBe(SHIM_DIR);
    expect(output.env.NEXUS_USER_ZDOTDIR).toBe("/home/user/.config/zsh");
    // Other env keys preserved
    expect(output.env.PATH).toBe("/usr/bin");
  });

  test("1b: shell=/bin/zsh, no ZDOTDIR → NEXUS_USER_ZDOTDIR is empty string", () => {
    const input = {
      shell: "/bin/zsh",
      env: { PATH: "/usr/bin" },
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env.ZDOTDIR).toBe(SHIM_DIR);
    expect(output.env.NEXUS_USER_ZDOTDIR).toBe("");
  });

  test("2: shell=zsh-5.9 → zsh branch (ZDOTDIR redirected)", () => {
    const input = {
      shell: "zsh-5.9",
      env: {},
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env.ZDOTDIR).toBe(SHIM_DIR);
    expect(output.env.NEXUS_USER_ZDOTDIR).toBe("");
  });

  test("3: shell=/bin/bash → args starts with --rcfile <shimDir>/bashrc -i", () => {
    const input = {
      shell: "/bin/bash",
      env: {},
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.args).toBeDefined();
    expect(output.args![0]).toBe("--rcfile");
    expect(output.args![1]).toBe(`${SHIM_DIR}/bashrc`);
    expect(output.args![2]).toBe("-i");
  });

  test("4: shell=/usr/local/bin/bash → same as /bin/bash", () => {
    const input = {
      shell: "/usr/local/bin/bash",
      env: {},
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.args).toBeDefined();
    expect(output.args![0]).toBe("--rcfile");
    expect(output.args![1]).toBe(`${SHIM_DIR}/bashrc`);
    expect(output.args![2]).toBe("-i");
  });

  test("5: shell=/usr/local/bin/fish → no-op (input returned unchanged)", () => {
    const env = { PATH: "/usr/bin" };
    const args = ["--login"];
    const input = {
      shell: "/usr/local/bin/fish",
      env,
      args,
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env).toBe(env);
    expect(output.args).toBe(args);
  });

  test("6: shell undefined + env.SHELL=/bin/zsh → zsh branch", () => {
    const input = {
      env: { SHELL: "/bin/zsh" },
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env.ZDOTDIR).toBe(SHIM_DIR);
    expect(output.env.NEXUS_USER_ZDOTDIR).toBe("");
  });

  test("7: shell undefined + env.SHELL undefined → no-op", () => {
    const env = { PATH: "/usr/bin" };
    const input = {
      env,
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.env).toBe(env);
    expect(output.args).toBeUndefined();
  });

  test("8: zsh branch + existing args → args unchanged", () => {
    const existingArgs = ["--login", "--interactive"];
    const input = {
      shell: "/bin/zsh",
      env: {},
      args: existingArgs,
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    // zsh uses env mutation, args must remain as-is
    expect(output.args).toBe(existingArgs);
    expect(output.env.ZDOTDIR).toBe(SHIM_DIR);
  });

  test("9: bash branch + existing args → --rcfile/-i prepended before existing args", () => {
    const existingArgs = ["--login"];
    const input = {
      shell: "/bin/bash",
      env: {},
      args: existingArgs,
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.args).toBeDefined();
    expect(output.args![0]).toBe("--rcfile");
    expect(output.args![1]).toBe(`${SHIM_DIR}/bashrc`);
    expect(output.args![2]).toBe("-i");
    expect(output.args![3]).toBe("--login");
    // original args array not mutated
    expect(existingArgs).toEqual(["--login"]);
  });

  test("bash branch, args=undefined → new array created with shim args only", () => {
    const input = {
      shell: "/bin/bash",
      env: {},
      shimDir: SHIM_DIR,
    };
    const output = applyShellPathShim(input);

    expect(output.args).toEqual(["--rcfile", `${SHIM_DIR}/bashrc`, "-i"]);
  });

  test("input env object is not mutated (zsh branch)", () => {
    const originalEnv = { ZDOTDIR: "/orig", PATH: "/usr/bin" };
    const input = {
      shell: "/bin/zsh",
      env: { ...originalEnv },
      shimDir: SHIM_DIR,
    };
    applyShellPathShim(input);
    // input.env should not be mutated
    expect(input.env.ZDOTDIR).toBe("/orig");
  });
});
