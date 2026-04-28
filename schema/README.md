# schema

JSON Schema contract sources for E1 workspace shell.

These schemas intentionally cover only:

- Workspace Registry metadata
- Last Session Snapshot restore state
- Workspace open/activate/close actions
- Sidecar start/stop lifecycle messages
- LSP sidecar lifecycle and stdio relay messages

Terminal/editor renderer state remains outside these sidecar contracts.
