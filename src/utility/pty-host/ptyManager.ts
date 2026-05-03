// PTY manager — owns one node-pty IPty per tab.
// Runs inside the utility process; communicates with the main process via
// parentPort (MessagePort set up by ptyHost.ts in the main process).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MessagePortMain } from "electron";
import { FlowController } from "./flowControl";
import { TerminalRecorder } from "./terminalRecorder";

// node-pty is required at runtime — it must not be bundled by Vite.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty") as typeof import("node-pty");

// ---------------------------------------------------------------------------
// zsh init wrapper (ZDOTDIR)
//
// zsh's PROMPT_SP option (default ON) pads every prompt with inverse-video
// spaces and a PROMPT_EOL_MARK glyph (default '%') when the previous
// command's output didn't end with a newline. In a GUI terminal this is
// noise. PROMPT_EOL_MARK can be blanked via env, but PROMPT_SP is a zsh
// shell option (not an env var) and can only be turned off from inside an
// rc file.
//
// We follow VSCode's pattern (see references/vscode/.../shellIntegration-*.zsh
// and src/vs/platform/terminal/node/terminalEnvironment.ts L212-257):
//
//   1. Create a private ZDOTDIR under tmpdir (username-namespaced, sticky-bit
//      0o1700 so other users on the host can't tamper).
//   2. Pass USER_ZDOTDIR = original $ZDOTDIR (or $HOME if unset) so the
//      wrapper rc can find the user's real dotfiles.
//   3. Each wrapper rc temporarily restores ZDOTDIR to USER_ZDOTDIR before
//      sourcing the user's file, then restores ours. Recursion is guarded
//      via marker variables.
//   4. .zshrc additionally turns off PROMPT_SP / PROMPT_EOL_MARK BEFORE
//      sourcing the user's ~/.zshrc so a user who explicitly wants the
//      behavior can re-enable it in their own rc.
//
// Non-zsh shells (bash, fish, sh) ignore ZDOTDIR, so the env addition is
// a no-op for them.
// ---------------------------------------------------------------------------

let zshInitDir: string | null = null;

function ensureZshInitDir(): string {
  if (zshInitDir) return zshInitDir;
  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    // fall back to "unknown" — userInfo can fail in unusual containerized envs
  }
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const dir = path.join(realTmpDir, `${username}-nexus-code-zsh`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Sticky bit + owner-only permissions so other local users cannot tamper.
    fs.chmodSync(dir, 0o1700);
  } catch {
    // ignore — best-effort hardening
  }

  // .zshenv — always sourced. Temporarily swap ZDOTDIR so the user's
  // ~/.zshenv (or $USER_ZDOTDIR/.zshenv) sees its expected ZDOTDIR.
  fs.writeFileSync(
    path.join(dir, ".zshenv"),
    [
      'if [[ -f "$USER_ZDOTDIR/.zshenv" ]]; then',
      '  NEXUS_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      '  if [[ "$USER_ZDOTDIR" != "$NEXUS_ZDOTDIR" ]]; then',
      '    . "$USER_ZDOTDIR/.zshenv"',
      "  fi",
      '  USER_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$NEXUS_ZDOTDIR"',
      "fi",
      "",
    ].join("\n"),
  );

  // .zprofile — login-shell only. Recursion-guarded.
  fs.writeFileSync(
    path.join(dir, ".zprofile"),
    [
      'if [[ -n "$NEXUS_PROFILE_INITIALIZED" ]]; then',
      "  return",
      "fi",
      "export NEXUS_PROFILE_INITIALIZED=1",
      'if [[ $options[norcs] = off && -o "login" ]]; then',
      '  if [[ -f "$USER_ZDOTDIR/.zprofile" ]]; then',
      '    NEXUS_ZDOTDIR="$ZDOTDIR"',
      '    ZDOTDIR="$USER_ZDOTDIR"',
      '    . "$USER_ZDOTDIR/.zprofile"',
      '    ZDOTDIR="$NEXUS_ZDOTDIR"',
      "  fi",
      "fi",
      "",
    ].join("\n"),
  );

  // .zshrc — interactive shells. Apply our GUI defaults BEFORE sourcing
  // the user's ~/.zshrc so the user can re-enable PROMPT_SP in their rc.
  fs.writeFileSync(
    path.join(dir, ".zshrc"),
    [
      "# nexus-code: GUI-terminal defaults — set BEFORE sourcing user rc",
      "# so the user can re-enable PROMPT_SP / PROMPT_EOL_MARK in ~/.zshrc.",
      "unsetopt PROMPT_SP 2>/dev/null",
      "PROMPT_EOL_MARK=''",
      "",
      "# Prevent recursive sourcing if .zshrc somehow re-enters.",
      'if [[ -n "$NEXUS_ZSH_RC_LOADED" ]]; then',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      "  return",
      "fi",
      "export NEXUS_ZSH_RC_LOADED=1",
      "",
      "# zsh defaults HISTFILE to $ZDOTDIR; keep history in the user's dir.",
      'HISTFILE="$USER_ZDOTDIR/.zsh_history"',
      "",
      'if [[ $options[norcs] = off && -f "$USER_ZDOTDIR/.zshrc" ]]; then',
      '  NEXUS_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      '  . "$USER_ZDOTDIR/.zshrc"',
      "  # leave ZDOTDIR pointing at the user's dir for the rest of the session",
      "fi",
      "",
    ].join("\n"),
  );

  // .zlogin — login-shell only. Restore ZDOTDIR to the user's dir for
  // the rest of the session (matches VSCode's behavior).
  fs.writeFileSync(
    path.join(dir, ".zlogin"),
    [
      'ZDOTDIR="$USER_ZDOTDIR"',
      'if [[ $options[norcs] = off && -o "login" && -f "$ZDOTDIR/.zlogin" ]]; then',
      '  . "$ZDOTDIR/.zlogin"',
      "fi",
      "",
    ].join("\n"),
  );

  zshInitDir = dir;
  return dir;
}

// Resolve the user's effective ZDOTDIR for USER_ZDOTDIR.
// If they had ZDOTDIR set in their environment, preserve it; otherwise
// fall back to $HOME (which is where standard zsh dotfiles live).
function resolveUserZdotdir(): string {
  const existing = process.env.ZDOTDIR;
  if (existing && existing.length > 0) return existing;
  return os.homedir() || "~";
}

interface TabState {
  pty: import("node-pty").IPty;
  flow: FlowController;
  recorder: TerminalRecorder;
}

// Inbound message shapes (main → utility)
interface SpawnMsg {
  type: "spawn";
  tabId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}
interface WriteMsg {
  type: "write";
  tabId: string;
  data: string;
}
interface ResizeMsg {
  type: "resize";
  tabId: string;
  cols: number;
  rows: number;
}
interface AckMsg {
  type: "ack";
  tabId: string;
  charCount: number;
}
interface KillMsg {
  type: "kill";
  tabId: string;
}

type InboundMsg = SpawnMsg | WriteMsg | ResizeMsg | AckMsg | KillMsg;

export class PtyManager {
  private tabs = new Map<string, TabState>();
  private port: MessagePortMain | null = null;

  // Attach the MessagePort that connects to the main process.
  // All outbound events are sent via this port.
  attachPort(port: MessagePortMain): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  private send(msg: unknown): void {
    if (this.port) {
      this.port.postMessage(msg);
    }
  }

  private handleMessage(msg: InboundMsg): void {
    switch (msg.type) {
      case "spawn":
        this.spawn(msg.tabId, msg.cwd, msg.shell, msg.cols, msg.rows);
        break;
      case "write":
        this.write(msg.tabId, msg.data);
        break;
      case "resize":
        this.resize(msg.tabId, msg.cols, msg.rows);
        break;
      case "ack":
        this.ack(msg.tabId, msg.charCount);
        break;
      case "kill":
        this.kill(msg.tabId);
        break;
    }
  }

  spawn(tabId: string, cwd: string, shell: string, cols: number, rows: number): void {
    if (this.tabs.has(tabId)) {
      return;
    }

    let proc: import("node-pty").IPty;
    try {
      proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          // Point zsh at our ZDOTDIR wrapper, and tell the wrapper where
          // the user's real dotfiles live via USER_ZDOTDIR (= the user's
          // pre-existing ZDOTDIR if any, otherwise $HOME). This mirrors
          // VSCode's terminalEnvironment.ts pattern. PROMPT_EOL_MARK is
          // also re-asserted in env for the --no-rcs case where the
          // wrapper rc would be skipped. Non-zsh shells ignore all three.
          ZDOTDIR: ensureZshInitDir(),
          USER_ZDOTDIR: resolveUserZdotdir(),
          PROMPT_EOL_MARK: "",
        },
      });
    } catch {
      this.send({ type: "exit", tabId, code: 1, signal: undefined });
      return;
    }

    const flow = new FlowController();
    const recorder = new TerminalRecorder(cols, rows);

    const state: TabState = { pty: proc, flow, recorder };
    this.tabs.set(tabId, state);

    proc.onData((data: string) => {
      recorder.handleData(data);
      const shouldPause = flow.onData(data.length);
      this.send({ type: "data", tabId, chunk: data });
      if (shouldPause) {
        proc.pause();
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      this.tabs.delete(tabId);
      this.send({ type: "exit", tabId, code: exitCode ?? null, signal: signal ?? undefined });
    });

    this.send({ type: "spawned", tabId, pid: proc.pid });
  }

  write(tabId: string, data: string): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.pty.write(data);
    }
  }

  resize(tabId: string, cols: number, rows: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.pty.resize(cols, rows);
      state.recorder.handleResize(cols, rows);
    }
  }

  ack(tabId: string, charCount: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      const shouldResume = state.flow.onAck(charCount);
      if (shouldResume) {
        state.pty.resume();
      }
    }
  }

  kill(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (state) {
      this.tabs.delete(tabId);
      try {
        state.pty.kill();
      } catch {
        // ignore — process may have already exited
      }
    }
  }

  killAll(): void {
    for (const tabId of this.tabs.keys()) {
      this.kill(tabId);
    }
  }
}
