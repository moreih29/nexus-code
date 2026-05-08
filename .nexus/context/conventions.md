# Project Conventions

## IPC correlation keys

Broadcast/listen subscription payloads must use domain identifiers for correlation, such as `workspaceId`, `tabId`, or `uri`. Do not use transport request identifiers (`requestId`, `streamId`) as domain correlation keys.

Use `ipcStream` for renderer-started unit-of-work operations that need progress and completion. In `ipcStream`, the main router owns `streamId`; domain schemas and handlers must not expose it.
