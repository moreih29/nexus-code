/**
 * New lines that come while a tab asks the agent for its log again. The
 * agent sends the log's lines as they were and goes on with new ones, which
 * may come first: the model, taking a new line, is past the log's earlier
 * ones and skips them as seen, and a program started over (a session taken
 * up, a rewind) is lost with them. Held until the log is in, they come after.
 */

import type { ChatLine } from "./model";

export class LiveLines {
  private depth = 0;
  private held: ChatLine[] = [];

  /** New lines wait from now on, until as many releases as holds. */
  hold(): void {
    this.depth += 1;
  }

  /** Whether `line` waits: a new one while held. The log's own lines never do. */
  holds(line: ChatLine): boolean {
    if (this.depth === 0 || line.replay) return false;
    this.held.push(line);
    return true;
  }

  /** Ends a hold; the lines held, in the order they came, once none is left. */
  release(): ChatLine[] {
    if (this.depth === 0) return [];
    this.depth -= 1;
    if (this.depth > 0) return [];
    const lines = this.held;
    this.held = [];
    return lines;
  }
}
