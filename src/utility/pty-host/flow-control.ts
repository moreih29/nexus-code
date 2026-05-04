// Per-tab flow control state machine.
// Mirrors VSCode FlowControlConstants but owns no I/O — callers push state and
// read back whether the producer should be paused or resumed.

import { TERMINAL_FLOW_CONTROL } from "../../shared/terminal-flow-control";

export const HighWatermarkChars = TERMINAL_FLOW_CONTROL.HIGH_WATERMARK;
export const LowWatermarkChars = TERMINAL_FLOW_CONTROL.LOW_WATERMARK;
export const CharCountAckSize = TERMINAL_FLOW_CONTROL.ACK_SIZE;

export class FlowController {
  private unacknowledged = 0;
  private paused = false;

  // Called by the producer when new data chars are sent.
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
