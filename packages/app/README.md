# @nexus/app

Electron app package for the Phase A Runnable Shell.

## Phase A status

Phase A is implemented and manually validated for **unsigned dev launch**.

- Launch mode: `cd packages/app && bun run dev`
- Final evidence: `test/phase-a/evidence/2026-04-24T15-12-00KST_task11/`
- Gate summary: `test/phase-a/manual-integration-checklist.md`
- Final verdict: PASS for workspace sidebar, workspace-specific terminal cwd, terminal input/output, multi-tab behavior, Korean IME manual validation, restart/session restore, sidecar lifecycle, and fast workspace switching render stability.

This package does **not** treat notarized/codesigned app QA as a Phase A release gate. `package:dir` and `package:mac` remain packaging scripts, but signed-app distribution is outside the Phase A roadmap scope.

## Runtime shell

- The renderer is a React + Tailwind shell using shadcn-style `Button` and `Tabs` primitives.
- The shell reserves the MVP 4-column layout:
  1. activity bar
  2. workspace/filetree side panel
  3. center terminal/editor area
  4. right shared panel for tool/session/diff/preview tabs
- `electron-vite` builds the main, preload, and renderer entry points.

## Workspace behavior

- Users can open folders, switch active workspaces from the sidebar, close workspaces, and restore the previous workspace session after restart.
- Workspace IPC is exposed through preload and persisted by the main process.
- Terminal startup resolves `workspaceId -> absolutePath`, so each terminal opens with the selected workspace as `cwd`.

## Terminal behavior

- Shell terminals are workspace-scoped and support multiple tabs per workspace.
- PTYs run in the Electron main process through `node-pty`; renderer code communicates over IPC and must not import `node-pty`.
- The renderer imports `@xterm/xterm/css/xterm.css` and uses xterm.js with WebGL, Unicode11, `allowProposedApi: true`, focus repair, and visibility repair that clears the WebGL texture atlas and refreshes rows after workspace/tab switches.
- Inactive workspace terminals stay mounted but hidden so tab state is preserved during switching.

## Sidecar behavior

- `bun run build:sidecar` compiles the Go sidecar binary into `sidecar/bin/nexus-sidecar`.
- Phase A sidecar support is lifecycle-only: one process per open workspace, start on session restore/open, stop on workspace close/app shutdown, and process cleanup evidence captured under the Phase A evidence directory.
- Schema codegen and sidecar WebSocket lifecycle handshake work are deferred to E3.

## Common commands

| Purpose | Command |
| --- | --- |
| Dev launch | `bun run dev` |
| Build sidecar only | `bun run build:sidecar` |
| Rebuild native addon | `bun run rebuild:native` |
| Build app | `bun run build` |
| Build then preview | `bun run start` |
| Preview existing build | `bun run preview` |
| Renderer lint | `bun run lint:renderer` |
| Renderer node-pty import guard | `bun run smoke:renderer-node-pty-guard` |
| Native node-pty smoke | `bun run verify:native` |
| IME checklist gate | `bun run test:ime-checklist` |
| Runtime terminal gate | `bun run test:runtime-terminal` |
| Directory package | `bun run package:dir` |
| macOS package script | `bun run package:mac` |
