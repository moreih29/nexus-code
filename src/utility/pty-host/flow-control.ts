// Per-tab flow control state machine.
// Mirrors VSCode FlowControlConstants but owns no I/O — callers push state and
// read back whether the producer should be paused or resumed.

export const HighWatermarkChars = 100000;
export const LowWatermarkChars = 5000;
export const CharCountAckSize = 5000;

export class FlowController {
  private unacknowledged = 0;
  private paused = false;

  // Called by the producer when new data bytes are sent.
  // Returns true if the producer should now be paused.
  onData(charCount: number): boolean {
    this.unacknowledged += charCount;
    if (!this.paused && this.unacknowledged >= HighWatermarkChars) {
      this.paused = true;
    }
    return this.paused;
  }

  // Called when the consumer sends an ack.
  // Returns true if the producer should now be resumed.
  onAck(charCount: number): boolean {
    this.unacknowledged = Math.max(0, this.unacknowledged - charCount);
    if (this.paused && this.unacknowledged <= LowWatermarkChars) {
      this.paused = false;
      return true;
    }
    return false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getUnacknowledged(): number {
    return this.unacknowledged;
  }
}
