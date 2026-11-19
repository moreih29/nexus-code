import type { TranscriptPageResult } from "../../../../shared/ipc/contract";
import { historyModel } from "./history";

/** An agent snapshot's rows, from oldest to newest. The live log is kept separately. */
export class TranscriptPages {
  readonly snapshot: string;
  readonly truncated: boolean;
  cursor: string | undefined;
  beforeAnchor: string | undefined;
  cursorExpired = false;
  private readonly keySnapshot: string;
  private entries: unknown[];
  private positions: number[];
  private partial: { position: number; parts: Uint8Array[] } | undefined;

  constructor(page: TranscriptPageResult, snapshot: string, retained?: TranscriptPages) {
    this.snapshot = snapshot;
    this.truncated = page.truncated;
    this.keySnapshot = retained?.keySnapshot ?? snapshot;
    this.entries = retained?.entries ?? [];
    this.positions = retained?.positions ?? [];
    this.prepend(page);
  }

  /** A batch can be abandoned without moving the displayed history's boundary. */
  copy(): TranscriptPages {
    const batch = new TranscriptPages(
      {
        found: true,
        lines: [],
        positions: [],
        snapshot: this.snapshot,
        truncated: this.truncated,
        cursor: this.cursor,
        beforeAnchor: this.beforeAnchor,
      },
      this.snapshot,
      this,
    );
    batch.partial = this.partial;
    batch.cursorExpired = this.cursorExpired;
    return batch;
  }

  expireCursor(): void {
    if (this.cursor) this.cursorExpired = true;
    this.cursor = undefined;
  }

  get hasEarlier(): boolean {
    return this.cursor !== undefined || this.cursorExpired;
  }

  prepend(page: TranscriptPageResult): void {
    if (
      !page.found ||
      page.snapshot !== this.snapshot ||
      page.truncated !== this.truncated ||
      !page.positions ||
      page.positions.length !== page.lines.length ||
      (page.cursor !== undefined && page.cursor === this.cursor)
    ) {
      throw new Error("The transcript page no longer joins this conversation");
    }
    const entries = [...page.lines];
    const positions = [...page.positions];
    let partial = this.partial;
    const fragment = page.fragment;
    if (fragment) {
      if (
        entries.length !== 0 ||
        (fragment.last ? partial !== undefined : partial?.position !== fragment.position) ||
        (!fragment.first && !page.cursor)
      ) {
        throw new Error("The transcript page has an incomplete row");
      }
      const bytes = Uint8Array.from(atob(fragment.data), (char) => char.charCodeAt(0));
      const parts = [bytes, ...(partial?.parts ?? [])];
      if (fragment.first) {
        const row = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let at = 0;
        for (const part of parts) {
          row.set(part, at);
          at += part.length;
        }
        entries.push(JSON.parse(new TextDecoder().decode(row)));
        positions.push(fragment.position);
        partial = undefined;
      } else {
        partial = { position: fragment.position, parts };
      }
    } else if (partial) {
      throw new Error("The transcript page omitted part of a row");
    }
    const newest = positions.at(-1);
    if (
      positions.some((position, i) => i > 0 && position <= positions[i - 1]) ||
      (newest !== undefined && this.positions.length > 0 && newest >= this.positions[0])
    ) {
      throw new Error("The transcript page overlaps previously read rows");
    }
    if (entries.length > 0) {
      this.entries = entries.concat(this.entries);
      this.positions = positions.concat(this.positions);
    }
    this.partial = partial;
    this.cursor = page.cursor;
    if (!partial) this.beforeAnchor = page.beforeAnchor;
  }

  project() {
    const history = historyModel(this.entries, undefined, this.positions);
    return {
      ...history,
      items: history.items.map((item) =>
        item.kind === "task_end" ? item : { ...item, key: `${this.keySnapshot}:${item.key}` },
      ),
    };
  }

  get hasPartialRow(): boolean {
    return this.partial !== undefined;
  }

  get lines(): readonly unknown[] {
    return this.entries;
  }
}
