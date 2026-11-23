import type { ChatLine } from "../model";

export class LiveLines {
  private depth = 0;
  private held: ChatLine[] = [];

  hold(): void {
    this.depth += 1;
  }

  holds(line: ChatLine): boolean {
    if (this.depth === 0 || line.replay) return false;
    this.held.push(line);
    return true;
  }

  release(): ChatLine[] {
    if (this.depth === 0) return [];
    this.depth -= 1;
    if (this.depth > 0) return [];
    const lines = this.held;
    this.held = [];
    return lines;
  }
}
