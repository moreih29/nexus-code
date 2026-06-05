/**
 * Regression tests for the pipe-level OS pause/resume backpressure gate
 * added to createNdjsonPipe's stdout handler.
 *
 * Two fixture tiers are used:
 *
 *   FakeReadable — synchronous, does not honor pause(). Tests gate accounting
 *   logic in isolation without depending on Node.js stream internals. All
 *   existing gate-counting assertions use this tier.
 *
 *   PassThrough — real Node.js stream that honors pause(). Tests that the
 *   post-burst resume check prevents a self-deadlock when the stream actually
 *   stops delivering data events after pause() is called. These tests use
 *   async callbacks (done pattern) and require the post-burst resume fix.
 *
 * Gate design recap (from pipe.ts createLineSplitter):
 *  - tally accumulates completed-line bytes within the current measurement window.
 *  - When tally > HWM: pause() fires, tally resets to 0 (starts fresh window).
 *  - When paused and tally <= LWM: resume() fires, tally resets to 0.
 *  - After every push() or flush() call: if paused and tally <= LWM, resume()
 *    fires unconditionally (post-burst resume — prevents permanent stall).
 *  - Partial-line bytes in the splitter's internal buffer are excluded.
 */
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";
import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";

// ---------------------------------------------------------------------------
// Constants mirrored from pipe.ts (must be kept in sync manually)
// ---------------------------------------------------------------------------
const BACKPRESSURE_HWM = 1 * 1024 * 1024; // 1 MiB
const BACKPRESSURE_LWM = 64 * 1024; // 64 KiB

// ---------------------------------------------------------------------------
// Fake stream helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Readable-compatible fake that records pause/resume calls and
 * allows driving data events synchronously via emitData().
 * The fake does NOT honor the paused state — emitData() always fires the
 * data event. This lets us test the gate accounting logic in isolation
 * without relying on the Node.js stream internals.
 */
class FakeReadable extends EventEmitter {
  pauseCount = 0;
  resumeCount = 0;
  paused = false;

  pause(): this {
    this.pauseCount++;
    this.paused = true;
    return this;
  }

  resume(): this {
    this.resumeCount++;
    this.paused = false;
    return this;
  }

  emitData(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }
}

/**
 * Creates one NDJSON event frame. Accepts an optional payload size so tests
 * can control the frame size precisely.
 */
function makeFrame(index: number, paddingSize = 0): Buffer {
  const padding = paddingSize > 0 ? "x".repeat(paddingSize) : undefined;
  const obj: Record<string, unknown> = { event: "test.frame", payload: { index } };
  if (padding !== undefined) obj.padding = padding;
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

function makeReadyFrame(): Buffer {
  return Buffer.from(JSON.stringify({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` }) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pipe backpressure gate", () => {
  /**
   * Core gate test: a burst of frames whose cumulative line bytes exceed HWM
   * must trigger at least one pause() call.
   *
   * Frame size: ~1,100 bytes each (padding=1_000).
   * 1,100 frames × 1,100 bytes ≈ 1.21 MiB > HWM (1 MiB).
   * The tally resets to 0 after each pause, so subsequent frames can trigger
   * further pause/resume cycles — demonstrating the gate is re-entrant.
   */
  it("pauses stdout when cumulative line bytes exceed HWM during a burst", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // 1,100 frames × ~1,100 bytes ≈ 1.21 MiB, which exceeds the 1 MiB HWM.
    const TOTAL_FRAMES = 1_100;
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }

    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * Resume gate test: after a pause(), the tally resets to zero. Subsequent
   * small frames (each well below LWM) must trigger resume().
   *
   * Steps:
   *  1. Send enough large frames to exceed HWM → pause fires, tally→0.
   *  2. Send one small frame (len << LWM). Tally = small len <= LWM while
   *     paused=true → resume fires immediately.
   */
  it("resumes stdout when tally is at or below LWM after a pause", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // Phase 1: push enough to trigger pause. 1,100 × ~1,100 bytes > HWM.
    for (let i = 0; i < 1_100; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }
    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);

    // After pause the tally has been reset to 0. Now push one tiny frame
    // (well under LWM = 64 KiB). The gate is in paused=true state and
    // tally (= tiny frame len ~44 bytes) <= LWM → resume must fire.
    stdout.emitData(makeFrame(9_999, 0)); // tiny frame, no padding

    expect(stdout.resumeCount).toBeGreaterThanOrEqual(1);
    // pause count must equal resume count (every pause is followed by resume).
    expect(stdout.pauseCount).toBe(stdout.resumeCount);
  });

  /**
   * 20,000-frame burst test matching the empirical bug scenario.
   * Uses small frames (~44 bytes each) to produce ~880 KB total — under HWM.
   * Verifies no spurious pause fires for a burst that stays below HWM.
   *
   * For larger-frame scenario see the HWM test above.
   */
  it("does not pause for a 20k small-frame burst whose total is below HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // 20,000 × ~44 bytes ≈ 880 KiB < HWM (1 MiB). No pause expected.
    for (let i = 0; i < 20_000; i++) {
      stdout.emitData(makeFrame(i, 0));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stdout.resumeCount).toBe(0);
  });

  /**
   * 20,000-frame burst test with frames large enough to exceed HWM.
   * Verifies: pause/resume both fire at least once, and the cycle repeats.
   * This models the empirical bug where maxBacklog reached 20,000.
   */
  it("pause and resume both fire during a 20k-frame burst that exceeds HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // Each frame is ~1,100 bytes; 20,000 × 1,100 ≈ 22 MiB >> HWM.
    // The gate resets tally to 0 on each pause, so the cycle repeats ~22 times.
    const TOTAL_FRAMES = 20_000;
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }

    // Both directions of the gate must have fired.
    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);
    expect(stdout.resumeCount).toBeGreaterThanOrEqual(1);

    // pause and resume counts must be equal: every pause cycle completes
    // with a resume when the next small-enough frame arrives (tally was reset
    // to 0 on pause, so a single ~1,100-byte frame with tally = 1,100 bytes
    // is <= LWM = 64 KiB and triggers resume immediately after the pause
    // burst finishes... unless the very next frame is ALSO large and the
    // new tally window immediately crosses HWM again).
    // At minimum pause count equals resume count OR pause count = resume + 1
    // (burst ends exactly mid-cycle).
    expect(stdout.pauseCount - stdout.resumeCount).toBeLessThanOrEqual(1);
  });

  it("does not pause stdout when frame volume stays well below HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // 10 small frames — far below HWM.
    for (let i = 0; i < 10; i++) {
      stdout.emitData(makeFrame(i, 0));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stdout.resumeCount).toBe(0);
  });

  it("stderr splitter does not affect stdout backpressure gate", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    // Push many large stderr lines — must not trigger pause on stdout.
    for (let i = 0; i < 2_000; i++) {
      stderr.emitData(Buffer.from(`stderr ${"x".repeat(1_000)}\n`, "utf8"));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stderr.pauseCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PassThrough-based variants — real stream honors pause()
// ---------------------------------------------------------------------------
// These tests use a real Node.js PassThrough so that pause() actually stops
// data-event delivery. They guard against regressions where the post-burst
// resume check is accidentally removed, which would re-introduce the
// self-deadlock caught by the tester in the first review cycle.
// ---------------------------------------------------------------------------

// Helper used by PassThrough tests only — produces frames with a named event.
function makeNamedFrame(event: string, index: number, paddingSize = 0): Buffer {
  const obj: Record<string, unknown> = { event, payload: { index } };
  if (paddingSize > 0) obj.padding = "x".repeat(paddingSize);
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

describe("pipe backpressure gate — PassThrough (real stream, honors pause)", () => {
  /**
   * Async-write scenario: frames arrive one per setImmediate tick, simulating
   * a real child process writing small chunks. When the gate fires pause() after
   * ~960 frames, the stream actually stops. The post-burst resume check must
   * fire at the end of the push() call that contained the pause-triggering line,
   * allowing the stream to deliver the next chunk and eventually all frames.
   *
   * Without the post-burst resume fix this test stalls permanently
   * (ptyReceived < PTY_FRAMES, fsReceived = 0).
   */
  it("delivers all frames when gate fires pause during async one-per-tick writes", (done) => {
    const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
    const stderr = new PassThrough();
    const stdin = new FakeWritable();

    let ptyReceived = 0;
    let fsReceived = 0;

    const pipe = createNdjsonPipe({
      stdout,
      stderr,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: (err) => done(err),
    });

    pipe.on("pty.data", () => ptyReceived++);
    pipe.on("fs.changed", () => fsReceived++);

    const PTY_FRAMES = 1_100;
    const FS_FRAMES = 5;

    let i = 0;
    function writeNext() {
      if (i === 0) {
        stdout.write(makeReadyFrame());
      } else if (i <= PTY_FRAMES) {
        stdout.write(makeNamedFrame("pty.data", i - 1, 1_000));
      } else if (i <= PTY_FRAMES + FS_FRAMES) {
        // Small non-PTY frames that are permanently dropped without the fix.
        stdout.write(makeNamedFrame("fs.changed", i - PTY_FRAMES - 1));
      } else {
        setTimeout(() => {
          try {
            expect(stdout.isPaused()).toBe(false);
            expect(ptyReceived).toBe(PTY_FRAMES);
            expect(fsReceived).toBe(FS_FRAMES);
            done();
          } catch (err) {
            done(err);
          }
        }, 200);
        return;
      }
      i++;
      setImmediate(writeNext);
    }
    setImmediate(writeNext);
  }, 10_000);

  /**
   * Batch-write scenario: all frames written in a single PassThrough.write()
   * call. The gate fires pause() mid-chunk but all lines in that chunk have
   * already been emitted synchronously. The post-burst resume check fires at
   * the end of push() so the stream is immediately un-paused, ready for any
   * future chunks.
   */
  it("delivers all frames when all data arrives in one PassThrough write (batch scenario)", (done) => {
    const stdout = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
    const stderr = new PassThrough();
    const stdin = new FakeWritable();

    let ptyReceived = 0;
    let fsReceived = 0;

    const pipe = createNdjsonPipe({
      stdout,
      stderr,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: (err) => done(err),
    });

    pipe.on("pty.data", () => ptyReceived++);
    pipe.on("fs.changed", () => fsReceived++);

    const PTY_FRAMES = 1_100;
    const FS_FRAMES = 20;

    const chunks: Buffer[] = [makeReadyFrame()];
    for (let i = 0; i < PTY_FRAMES; i++) chunks.push(makeNamedFrame("pty.data", i, 1_000));
    for (let i = 0; i < FS_FRAMES; i++) chunks.push(makeNamedFrame("fs.changed", i));

    stdout.write(Buffer.concat(chunks));
    stdout.end();

    stdout.on("end", () => {
      setImmediate(() => {
        try {
          expect(ptyReceived).toBe(PTY_FRAMES);
          expect(fsReceived).toBe(FS_FRAMES);
          expect(stdout.isPaused()).toBe(false);
          done();
        } catch (err) {
          done(err);
        }
      });
    });
    stdout.on("error", (err) => done(err));
  }, 10_000);
});
