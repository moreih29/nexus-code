export class ConnectionRestart {
  private requested?: string;
  private timer?: ReturnType<typeof setTimeout>;
  active?: Promise<boolean>;
  private disposed = false;

  constructor(
    private readonly state: (profileId: string) => "wait" | "ready" | "skip",
    private readonly restart: () => Promise<boolean>,
    private readonly ready: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  request(profileId: string): void {
    if (this.disposed) return;
    this.requested = profileId;
    this.schedule(0);
  }

  whenIdle(): Promise<boolean> | undefined {
    if (this.active || !this.requested) return this.active;
    const profileId = this.requested;
    const state = this.state(profileId);
    if (state === "wait") {
      this.schedule(250);
      return;
    }
    this.requested = undefined;
    if (state === "skip") return;
    this.active = Promise.resolve()
      .then(this.restart)
      .catch((error: unknown) => {
        this.failed(error);
        return false;
      })
      .then((ok) => {
        this.active = undefined;
        if (this.disposed) return ok;
        if (ok) {
          this.schedule(0);
          this.ready();
        } else this.requested ??= profileId;
        return ok;
      });
    return this.active;
  }

  async wait(restart: Promise<boolean>): Promise<boolean> {
    let current: Promise<boolean> | undefined = restart;
    while (current) {
      if (!(await current)) return false;
      current = this.whenIdle();
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = undefined;
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined || this.active || !this.requested) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.whenIdle();
    }, delay);
  }
}
