const entries = [
  {
    check: "macOS arm64 node-pty smoke (automated)",
    status: "ready",
    command: "bun run verify:native",
  },
  {
    check: "Korean IME/rendering release gate (automated deterministic seams)",
    status: "ready",
    command: "bun test ./test/system/ime-release-gate.test.ts",
  },
  {
    check: "macOS x64 node-pty smoke (manual on x64 host/runner)",
    status: "manual",
    command: "bun run verify:native",
  },
  {
    check: "Manual phase-gate QA (Dock + PATH/env + Korean IME + scrollback/copy/search) on arm64+x64",
    status: "manual",
    command:
      "Follow .nexus/memory/pattern-phase-gate-checklist.md and record outcome in CHANGELOG.md",
  },
];

for (const entry of entries) {
  console.log(`${entry.status.toUpperCase()}: ${entry.check}`);
  console.log(`  - Command: ${entry.command}`);
}
