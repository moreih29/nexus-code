# nexus-code

A VSCode-style editor and workspace tool for macOS. Combines Monaco + LSP with
cmux/warp-style workspace management. Built on Electron, React 19, and
electron-vite, with a Warp-inspired warm dark UI.

**macOS development only.** Packaging and cross-platform support are deferred
to a separate deployment ADR.

---

## Quick Start

```sh
bun install
bun run dev
```

A bare BrowserWindow opens. Renderer shows a placeholder page while features
are built across M0 milestones.

---

## Commands

| Command | Description |
|---|---|
| `bun run dev` | Start electron-vite dev server with HMR + launch Electron |
| `bun run build` | Production build to `out/` |
| `bun run preview` | Preview production build |
| `bun run typecheck` | Type-check all four TypeScript layers |
| `bun run clean` | Remove `out/` and `dist/` |

---

## Project Structure

```
src/
  main/           Electron main process (Node.js, no DOM)
    index.ts      App entry — app.whenReady, BrowserWindow lifecycle
    window.ts     BrowserWindow factory
    ipc/          IPC router (T2-T3)
    hosts/        utilityProcess launchers for PTY and LSP (T7, T9)
    storage/      SQLite-backed state/global/workspace storage (T4)
    workspace/    WorkspaceManager + WorkspaceContext (T5)
    platform/     macOS shell detection + path helpers (T6)
  preload/        Preload script — contextBridge only, no Node globals
  renderer/       React 19 renderer (DOM, no Node)
    App.tsx       Root component
    store/        State stores (T11)
    components/   UI components (T11)
    ipc/          IPC client calling preload bridge (T3)
    design/       CSS design tokens + globals (T2)
  utility/
    pty-host/     PTY utility process (T7-T8)
    lsp-host/     LSP utility process (T9-T10)
  shared/         Types and IPC contracts shared across all layers (T2)
tests/
  unit/
  integration/
  fixtures/
```

---

## Architecture

The app follows **Plan C'** (single BrowserWindow + utility processes):

- **Main process**: App lifecycle, window management, IPC routing, storage,
  workspace management. Node.js only — no DOM access.
- **Renderer process**: React UI with Monaco editor. DOM only — no direct Node
  access. All main-process calls go through the `window.ipc` bridge.
- **Preload script**: The only bridge between renderer and main. Exposes a typed
  `window.ipc` surface via `contextBridge`. `contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false` — all enforced.
- **Utility processes**: PTY and LSP run in isolated `utilityProcess` instances
  (Node.js, separate V8 context). Communication to main uses Electron
  `MessagePort` / `UtilityProcess` IPC, following VSCode's pattern.

### TypeScript Layers

Four separate `tsconfig.*.json` files enforce boundary rules at compile time:

| Layer | File | Allowed globals |
|---|---|---|
| `main` | `tsconfig.main.json` | Node only, no DOM |
| `preload` | `tsconfig.preload.json` | Node + limited DOM |
| `renderer` | `tsconfig.renderer.json` | DOM only, no Node types |
| `utility` | `tsconfig.utility.json` | Node only, no DOM |
| `shared` | `tsconfig.shared.json` | Neither (pure logic) |

All five are referenced from `tsconfig.json` as project references. Run
`bun run typecheck` to check all layers at once.

### Vite / electron-vite Notes

electron-vite 5.x supports three build targets: `main`, `preload`, `renderer`.
The `utility` processes (pty-host, lsp-host) are bundled as **additional entries
under the main build** via `rollupOptions.input`. They share the same `out/main/`
output directory and are loaded at runtime with:

```ts
utilityProcess.fork(join(__dirname, "pty-host.js"));
```

Native modules (`node-pty`, `better-sqlite3`) are listed in
`build.rollupOptions.external` so Vite emits `require()` calls that resolve
against the installed `node_modules` at runtime.

---

## Native Module Rebuild

`node-pty` and `better-sqlite3` are native Node addons that must be compiled
against the Electron ABI, not the system Node ABI.

`bun install` triggers the `postinstall` script which runs
`@electron/rebuild` automatically. If the rebuild fails (e.g., missing Xcode
command-line tools), run manually:

```sh
bunx @electron/rebuild
```

Verify Xcode CLT is installed: `xcode-select --install`

---

## Milestone Context (M0)

M0 establishes the project foundation. The tasks in this milestone are:

| Task | Scope |
|---|---|
| T1 (this) | Scaffold — bun + electron-vite + layered tsconfig + empty BrowserWindow |
| T2 | Shared types + design tokens |
| T3 | IPC contract (zod) + preload bridge + renderer IPC client |
| T4 | Storage layer (better-sqlite3) |
| T5 | Workspace layer (WorkspaceManager + WorkspaceContext) |
| T6 | Platform layer (macOS shell detection, paths) |
| T7-T8 | PTY utility process slice + integration test |
| T9-T10 | LSP utility process slice + integration test |
| T11 | Renderer shell integration (Monaco + terminal panel) |
| T12 | Cross-slice integration tests |
| T13 | M0 acceptance gate |

Packaging and 3-OS distribution are **not** in scope for M0. A deployment ADR
will cover electron-builder configuration for production builds.
