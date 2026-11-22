import type { WebContents } from "electron";
import type { SessionsRenderer, SessionsRevision } from "./context";
import type { RendererBridge } from "./renderer-bridge";

type RendererContents = Pick<
  WebContents,
  "id" | "isDestroyed" | "once" | "removeListener" | "send"
>;

/** Each window owns its revision and the lifetime of its cached reads. */
export class SessionsRevisions implements SessionsRevision {
  private readonly windows = new Map<number, { renderer: SessionsRenderer; close: () => void }>();

  constructor(
    private readonly bridge: RendererBridge,
    private readonly getContents: () => RendererContents | undefined,
  ) {}

  current(): SessionsRenderer | undefined {
    const contents = this.getContents();
    return contents && this.forWindow(contents);
  }

  saw(contents: RendererContents, revision: number): void {
    this.forWindow(contents)?.saw(revision);
  }

  private forWindow(contents: RendererContents): SessionsRenderer | undefined {
    if (contents.isDestroyed()) return undefined;
    const id = contents.id;
    const known = this.windows.get(id);
    if (known) return known.renderer;

    let latest: number | undefined;
    const lifetime = new AbortController();
    const renderer: SessionsRenderer = {
      get latest() {
        return latest;
      },
      get closed() {
        return lifetime.signal.aborted;
      },
      saw(revision) {
        if (!lifetime.signal.aborted && (latest === undefined || revision > latest))
          latest = revision;
      },
      snapshot: (args, timeoutMs) =>
        this.bridge.askIn(contents, "sessions.snapshot", args, timeoutMs, lifetime.signal),
    };
    const close = () => {
      lifetime.abort();
      latest = undefined;
      this.windows.delete(id);
      contents.removeListener("destroyed", close);
    };
    this.windows.set(id, { renderer, close });
    contents.once("destroyed", close);
    return renderer;
  }

  dispose(): void {
    for (const { close } of this.windows.values()) close();
  }
}
