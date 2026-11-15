// Loads an HTML preview pane's documents: puts each in main, which serves it
// at nexus-preview://<token>/ (main's custom-protocols/nexus-preview.ts), and
// points the pane's iframe at it.

/** Main's store of preview documents, as the loader uses it (the preview IPC channel). */
export interface PreviewDocumentStore {
  /**
   * Puts `html` under `token`, or under a new token when there is none or
   * main no longer holds it; null when the put failed.
   */
  put(html: string, token: string | undefined): Promise<{ token: string; url: string } | null>;
  /** Lets main go of `token`'s document. */
  release(token: string): void;
}

/** The iframe a pane shows its document in. */
export interface PreviewFrame {
  /** Points the frame at `url` (its src). */
  setSrc(url: string): void;
  /** Loads `url` again in place, leaving no history entry. */
  replace(url: string): void;
}

/**
 * One pane's documents. A pane keeps one token while it is open: the first
 * document under it sets the iframe's src, and the next load the same address
 * in place, so edits leave no history behind and a frame that is moved and
 * reloaded (movePortalTarget) loads the newest document. One put runs at a
 * time, under the token the one before got back; documents that pile up
 * behind it collapse into the newest. Closing the pane lets main go of its
 * document, and of one a put still on its way brings back.
 */
export class PreviewDocumentLoader {
  private token: string | null = null;
  /** The token whose address the frame's src is. */
  private shown: string | null = null;
  private pending: string | null = null;
  private putting = false;
  private closed = false;

  constructor(
    private readonly store: PreviewDocumentStore,
    private readonly frame: () => PreviewFrame | null,
  ) {}

  /** Shows `html` in the frame, once the puts before it are done. */
  load(html: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending = html;
    return this.drain();
  }

  /** Lets main go of the pane's document; the loader loads nothing after. */
  close(): void {
    this.closed = true;
    this.pending = null;
    const token = this.token;
    this.token = null;
    if (token !== null) this.store.release(token);
  }

  private async drain(): Promise<void> {
    if (this.putting) return;
    this.putting = true;
    try {
      for (let html = this.pending; html !== null; html = this.pending) {
        this.pending = null;
        const put = await this.store.put(html, this.token ?? undefined);
        if (put === null) continue;
        if (this.closed) {
          this.store.release(put.token);
          return;
        }
        this.token = put.token;
        const frame = this.frame();
        if (!frame) continue;
        if (this.shown === put.token) {
          frame.replace(put.url);
        } else {
          this.shown = put.token;
          frame.setSrc(put.url);
        }
      }
    } finally {
      this.putting = false;
    }
  }
}
