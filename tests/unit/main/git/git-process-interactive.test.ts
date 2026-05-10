import { describe, expect, test } from "bun:test";
import { runGit } from "../../../../src/main/git/git-process";

interface PromptEnvSnapshot {
  readonly gitAskpass: string | null;
  readonly sshAskpass: string | null;
  readonly sshAskpassRequire: string | null;
  readonly gitTerminalPrompt: string | null;
}

const PRINT_PROMPT_ENV_SCRIPT = `
console.log(JSON.stringify({
  gitAskpass: process.env.GIT_ASKPASS ?? null,
  sshAskpass: process.env.SSH_ASKPASS ?? null,
  sshAskpassRequire: process.env.SSH_ASKPASS_REQUIRE ?? null,
  gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null,
}));
`;

describe("runGit interactive prompt environment", () => {
  test("defaults to non-interactive askpass echo behavior", async () => {
    const env = await readPromptEnv();

    expect(env).toEqual({
      gitAskpass: "echo",
      sshAskpass: "echo",
      sshAskpassRequire: "force",
      gitTerminalPrompt: "0",
    });
  });

  test("interactive mode leaves askpass helpers unset when no override is supplied", async () => {
    const env = await readPromptEnv({ interactive: true });

    expect(env).toEqual({
      gitAskpass: null,
      sshAskpass: null,
      sshAskpassRequire: null,
      gitTerminalPrompt: "0",
    });
  });

  test("interactive mode preserves caller-supplied askpass helpers", async () => {
    const env = await readPromptEnv({
      env: {
        GIT_ASKPASS: "/tmp/git-askpass-helper",
        SSH_ASKPASS: "/tmp/ssh-askpass-helper",
        SSH_ASKPASS_REQUIRE: "force",
      },
      interactive: true,
    });

    expect(env).toEqual({
      gitAskpass: "/tmp/git-askpass-helper",
      sshAskpass: "/tmp/ssh-askpass-helper",
      sshAskpassRequire: "force",
      gitTerminalPrompt: "0",
    });
  });
});

/**
 * Runs a tiny JS process through runGit so the test observes real spawn env.
 */
async function readPromptEnv(
  options: { readonly env?: NodeJS.ProcessEnv; readonly interactive?: boolean } = {},
): Promise<PromptEnvSnapshot> {
  const result = await runGit({
    bin: process.execPath,
    cwd: process.cwd(),
    args: ["-e", PRINT_PROMPT_ENV_SCRIPT],
    env: options.env,
    interactive: options.interactive,
  });
  return JSON.parse(result.stdout) as PromptEnvSnapshot;
}
