# empirical: reconnecting channel stdout backpressure

Date: 2026-05-14

## Question

Can renderer `pty.ack` remain the only source of truth for PTY flow control, or does `reconnecting-process-channel` drain agent stdout into JS/Electron buffers independently of downstream consumer pace?

## Code review

`src/main/infra/agent/reconnecting-process-channel.ts` does not implement stdout flow control itself. Each process attempt constructs an `NdjsonPipe` and forwards stored event subscriptions to it. The only bounded queue in this file is the reconnect-window RPC queue (`maxPendingCalls`, default 32); it does not apply to stdout events.

The stdout read loop lives in `src/main/infra/agent/pipe.ts`: `deps.stdout.on("data", ...)` puts the child stdout stream into flowing mode, appends chunks to a string line splitter, parses every complete NDJSON line synchronously, and emits event callbacks synchronously. There is no `pause()`, `resume()`, high-watermark, awaited callback, or credit accounting linked to renderer `pty.ack`. The line splitter only bounds normal newline-delimited frames by the current partial line; a malformed/no-newline producer can still grow that string until close.

## Reproducer

Command: `bun /tmp/nexus-backpressure-repro.ts` (temporary script, removed after capture). It used the real `createReconnectingProcessChannel`, spawned a child that wrote `ready` plus 20,000 `pty.data` NDJSON event frames, and simulated a slow downstream consumer that consumed one frame every 5 ms.

Result:

```json
{
  "totalFrames": 20000,
  "received": 20000,
  "consumedAfterCloseAnd100ms": 18,
  "maxBacklog": 20000,
  "closeInfo": { "code": 0, "signal": null },
  "elapsedMs": 203.8
}
```

The child completed and the channel delivered all 20,000 frames in about 204 ms while the simulated consumer had consumed only 18 frames. That confirms stdout/event delivery is paced by the Node read loop and synchronous callback return, not by downstream consumer progress.

## Conclusion

Drain is present. Renderer ack alone is not a sufficient end-to-end bound once PTY output moves onto the reconnecting agent channel: main can continue draining Go agent stdout and enqueueing/broadcasting data while the renderer has not consumed or acknowledged it. Issue 3 needs correction before implementing the Go PTY service: add a main↔agent backpressure/credit window or equivalent stdout pause/resume mechanism so agent stdout production cannot outrun main/renderer consumption indefinitely.
