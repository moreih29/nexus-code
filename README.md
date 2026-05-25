# NexusCode

Multi-workspace VSCode-style editor for macOS — Monaco + LSP + PTY in one window.

## Requirements

- macOS 14 (Sonoma) or later
- Apple Silicon (arm64) or Intel (x64)

## Install

Download the latest release from the [Releases page](https://github.com/moreih29/nexus-code/releases).

| Your Mac | File to download |
|---|---|
| Apple Silicon (M1/M2/M3/M4) | `NexusCode-X.Y.Z-arm64.dmg` |
| Intel | `NexusCode-X.Y.Z-x64.dmg` |

Mount the `.dmg`, drag **NexusCode** into `/Applications`, and open it.

> **First run:** macOS Gatekeeper will block the app because it is not yet notarized.
> See [docs/INSTALL.md](docs/INSTALL.md) for the exact bypass steps for macOS 14 and 15+.

## Channels

| Channel | Description |
|---|---|
| **Stable** | Recommended. Released when a non-pre-release GitHub Release is published. |
| **Beta** | Opt-in. Receives pre-release builds. May contain rough edges. |

Switch channels in **Settings → Updates → Update Channel**.

## Development

Prerequisites, self-build commands, and output locations are documented in
[docs/INSTALL.md#self-build](docs/INSTALL.md#self-build).

## License

TBD
