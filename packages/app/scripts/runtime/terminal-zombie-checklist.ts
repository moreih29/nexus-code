const lines = [
  "MANUAL (FULL APP): PTY zombie-process verification",
  "",
  "This repository currently runs deterministic runtime verification with fake TerminalHost/Xterm seams.",
  "For real PTY process/zombie checks, run the full Electron app and execute this checklist:",
  "",
  "1) Start app runtime: bun run dev (inside packages/app).",
  "2) Open 3 workspaces with 2 tabs each; in one background tab run: yes runtime-tail | head -n 50000",
  "3) Switch workspaces/tabs repeatedly (>=100), then close each workspace.",
  "4) Capture candidate PTY processes:",
  "   pgrep -fal 'node-pty|zsh|bash|login'",
  "5) Inspect process states (replace <PID_LIST>):",
  "   ps -o pid,ppid,state,etime,command -p <PID_LIST>",
  "6) FAIL if defunct/zombie states remain after a 5s grace period.",
  "",
  "Reference automated harness: bun run test:runtime-terminal",
];

for (const line of lines) {
  console.log(line);
}
