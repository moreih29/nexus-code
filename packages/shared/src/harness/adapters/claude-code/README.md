# Claude Code HarnessAdapter

Read-only adapter for Claude Code tab badge observation.

## Observation boundary

- The adapter consumes a sidecar/observer event stream. It does **not** receive Claude hooks directly.
- The adapter does **not** own the Unix socket listener, hook token files, or Claude settings installation.
- The adapter does **not** inject IDE approval decisions into Claude Code. Approval remains in Claude Code's TUI flow.

## 4-state mapper rule

The current mapper is intentionally small and follows the T1 PoC result:

| Claude hook-like input | Tab badge result |
| --- | --- |
| `PreToolUse` | `running` |
| `Notification` with `notification_type === "permission_prompt"` | `awaiting-approval` |
| `PostToolUse` | no badge event; records latest session/timestamp so older events cannot win |
| `Stop` | `completed` |
| `StopFailure`, explicit error fields, or error-like hook names | `error` |

A non-`permission_prompt` `Notification` is ignored. The adapter does not infer approval waits from elapsed time or debounce windows; automatic allowed/bypass tool runs can take long enough to make debounce-only inference unsafe.

## Concurrent sessions limitation

Concurrent Claude Code sessions in one workspace are handled as workspace-level **last-event-wins**. The adapter records only the latest session id/timestamp and emits badge events only when the incoming event is at least as recent as the recorded latest event. It does not maintain per-session badge state.
