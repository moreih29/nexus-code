export interface PreviewDocumentStore {
  put(html: string, token: string | undefined): Promise<{ token: string; url: string } | null>;
  release(token: string): void;
}

export interface PreviewFrame {
  setSrc(url: string): void;
  replace(url: string): void;
}

export class PreviewDocumentLoader {
  private token: string | null = null;
  private shown: string | null = null;
  private pending: string | null = null;
  private putting = false;
  private closed = false;

  constructor(
    private readonly store: PreviewDocumentStore,
    private readonly frame: () => PreviewFrame | null,
  ) {}

  load(html: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending = html;
    return this.drain();
  }

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
