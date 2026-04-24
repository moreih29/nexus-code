const entries = [
  {
    check: "macOS arm64 node-pty smoke (automated)",
    status: "ready",
    command: "bun run verify:native",
  },
  {
    check: "Korean IME/rendering release gate (automated deterministic seams)",
    status: "ready",
    command: "bun run test:ime-checklist",
  },
  {
    check: "macOS x64 node-pty smoke (manual on x64 host/runner)",
    status: "manual",
    command: "bun run verify:native",
  },
  {
    check: "Manual signed .app QA (Dock + PATH/env + Korean IME + scrollback/copy/search) on arm64+x64",
    status: "manual",
    command:
      "Follow packages/app/test/manual-qa/korean-release-checklist.md and store evidence under packages/app/test/manual-qa/release-evidence/<RUN_ID>/",
  },
  {
    check: "Signed .app codesign + notarization verification",
    status: "manual",
    command:
      "CSC_LINK=<p12> CSC_KEY_PASSWORD=<pwd> APPLE_ID=<id> APPLE_APP_SPECIFIC_PASSWORD=<pw> bun run package:mac",
  },
];

for (const entry of entries) {
  console.log(`${entry.status.toUpperCase()}: ${entry.check}`);
  console.log(`  - Command: ${entry.command}`);
}
