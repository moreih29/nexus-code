const { app } = require("electron");

const EXPECTED = "node-pty-smoke-ok";
const TIMEOUT_MS = 15000;

let completed = false;
const RUNTIME = `electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`;

function finish(code, message) {
  if (completed) {
    return;
  }

  completed = true;
  if (message) {
    console.log(message);
  }

  app.exit(code);
}

function getShellSpec() {
  if (process.platform === "win32") {
    return {
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", `echo ${EXPECTED}`],
    };
  }

  const fallbackShell = process.env.SHELL || "/bin/zsh";
  return {
    shell: fallbackShell,
    args: ["-lc", `printf '${EXPECTED}'`],
  };
}

app.whenReady().then(() => {
  try {
    const nodePty = require("node-pty");
    const { shell, args } = getShellSpec();

    const ptyProcess = nodePty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    let output = "";
    let sawExpectedOutput = false;

    const timeout = setTimeout(() => {
      ptyProcess.kill();
      finish(1, `[smoke] FAIL (${RUNTIME}): timeout after ${TIMEOUT_MS}ms; output=${JSON.stringify(output)}`);
    }, TIMEOUT_MS);

    ptyProcess.onData((chunk) => {
      output += chunk;
      if (output.includes(EXPECTED)) {
        sawExpectedOutput = true;
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      const passed = sawExpectedOutput;
      const status = passed ? "PASS" : "FAIL";
      finish(
        passed ? 0 : 1,
        `[smoke] ${status} (${RUNTIME}): exitCode=${exitCode} signal=${signal} output=${JSON.stringify(output)}`,
      );
    });
  } catch (error) {
    finish(1, `[smoke] FAIL (${RUNTIME}): ${error?.stack || error}`);
  }
});
