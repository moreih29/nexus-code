import type { KeychainItem, KeychainStatus } from "../../../shared/keychain";
import { KeychainLockedError, type SecretBox } from "../remote/sealed-file";

export interface Keychain {
  readonly box: SecretBox | null;
  decided(): Promise<void>;
  isOpen(): boolean;
  has(item: KeychainItem): boolean;
  unlock(): Promise<boolean>;
  request(): Promise<boolean>;
  whenOpen(key: string, task: () => Promise<void>): Promise<void>;
}

export interface KeychainControl extends Keychain {
  status(): KeychainStatus;
  subscribe(listener: (status: KeychainStatus) => void): () => void;
  open(): Promise<boolean>;
  putOff(): void;
}

export const KEYCHAIN_SLOW_MS = 500;

export function refusedByKeychain(call: "encrypt" | "decrypt", error: unknown): boolean {
  if (call === "encrypt") return true;
  return error instanceof Error && /temporarily unavailable/i.test(error.message);
}

export function openKeychain(
  box: SecretBox | null,
  warn: (message: string) => void = () => {},
): KeychainControl {
  return {
    box,
    decided: async () => {},
    isOpen: () => true,
    has: () => false,
    unlock: async () => true,
    request: async () => true,
    subscribe: () => () => {},
    whenOpen: (key, task) => task().catch((error: unknown) => warn(`${key}: ${describe(error)}`)),
    status: () => ({ state: "open", items: [], busy: false, refused: false }),
    open: async () => true,
    putOff: () => {},
  };
}

export interface KeychainGateDeps {
  readonly raw: Pick<SecretBox, "encrypt" | "decrypt">;
  items(): KeychainItem[];
  signature(): Promise<string | null>;
  readonly recorded: { get(): string | null; set(signature: string): void };
  onChange(status: KeychainStatus): void;
  warn?(message: string): void;
  slowMs?: number;
}

interface Waiting {
  task: () => Promise<void>;
  done: () => void;
  ran: Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queued(task: () => Promise<void>): Waiting {
  let done = () => {};
  const ran = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { task, done, ran };
}

export class KeychainGate implements KeychainControl {
  private state: KeychainStatus["state"] = "checking";
  private slow = 0;
  private refused = false;
  private readonly waiting = new Map<string, Waiting>();
  private readonly decision: Promise<void>;
  private answer: { promise: Promise<boolean>; settle(open: boolean): void } = settled(false);
  private flushing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(status: KeychainStatus) => void>();
  private signing: Promise<string | null> | null = null;
  private noted = false;
  readonly box: SecretBox;

  constructor(private readonly deps: KeychainGateDeps) {
    this.box = {
      available: true,
      encrypt: (text) => this.call("encrypt", () => deps.raw.encrypt(text)),
      decrypt: (data) => this.call("decrypt", () => deps.raw.decrypt(data)),
    };
    this.decision = this.decide();
  }

  status(): KeychainStatus {
    return {
      state: this.state,
      items: this.deps.items(),
      busy: this.slow > 0,
      refused: this.refused,
    };
  }

  decided(): Promise<void> {
    return this.decision;
  }

  isOpen(): boolean {
    return this.state === "open" || this.state === "opening";
  }

  has(item: KeychainItem): boolean {
    return this.deps.items().includes(item);
  }

  unlock(): Promise<boolean> {
    if (this.refused) return Promise.resolve(false);
    if (this.state === "checking") return this.decision.then(() => this.unlock());
    if (this.state === "ask") return this.answer.promise;
    if (this.state === "locked") this.openNow();
    return Promise.resolve(true);
  }

  request(): Promise<boolean> {
    if (this.refused) return Promise.resolve(false);
    if (this.state === "checking") return this.decision.then(() => this.request());
    if (this.state === "locked") {
      this.answer = asked();
      this.set("ask");
    }
    if (this.state === "ask") return this.answer.promise;
    return Promise.resolve(true);
  }

  open(): Promise<boolean> {
    if (this.refused) return Promise.resolve(false);
    if (this.state === "checking") return this.decision.then(() => this.open());
    if (this.state === "ask" || this.state === "locked") {
      this.openNow();
      this.answer.settle(true);
    }
    return this.flushing.then(() => this.state === "open");
  }

  subscribe(listener: (status: KeychainStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  putOff(): void {
    if (this.state !== "ask") return;
    this.set("locked");
    this.answer.settle(false);
  }

  whenOpen(key: string, task: () => Promise<void>): Promise<void> {
    if (this.isOpen()) return this.run(key, task);
    const before = this.waiting.get(key);
    const next = queued(task);
    this.waiting.set(key, next);
    if (before) void next.ran.then(before.done);
    return next.ran;
  }

  private async decide(): Promise<void> {
    if (this.deps.items().length > 0) {
      const signature = await this.signature();
      if (signature === null || signature !== this.deps.recorded.get()) {
        this.answer = asked();
        this.set("ask");
        return;
      }
    }
    this.openNow();
  }

  private openNow(): void {
    if (this.state === "opening" || this.state === "open") return;
    this.set("opening");
    const tasks = [...this.waiting];
    this.waiting.clear();
    this.flushing = Promise.all(
      tasks.map(async ([key, { task, done }]) => {
        await this.run(key, task);
        done();
      }),
    ).then(() => {
      if (this.state === "opening") this.set("open");
    });
  }

  private async run(key: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (!(error instanceof KeychainLockedError)) {
        this.deps.warn?.(`${key}: ${describe(error)}`);
      } else if (!this.waiting.has(key)) {
        this.waiting.set(key, queued(task));
      }
    }
  }

  private async call<T>(kind: "encrypt" | "decrypt", work: () => Promise<T>): Promise<T> {
    if (!this.isOpen()) throw new KeychainLockedError();
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      this.slow++;
      this.changed();
    }, this.deps.slowMs ?? KEYCHAIN_SLOW_MS);
    try {
      const result = await work();
      this.opened();
      return result;
    } catch (error) {
      if (refusedByKeychain(kind, error)) {
        this.deps.warn?.(`the keychain gave no key: ${describe(error)}`);
        const first = !this.refused;
        this.refused = true;
        if (this.state !== "locked") this.set("locked");
        else if (first) this.changed();
        throw new KeychainLockedError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (slow) {
        this.slow--;
        this.changed();
      }
    }
  }

  private opened(): void {
    if (this.noted) return;
    this.noted = true;
    void this.signature().then((signature) => {
      if (signature !== null && signature !== this.deps.recorded.get()) {
        this.deps.recorded.set(signature);
      }
    });
  }

  private signature(): Promise<string | null> {
    this.signing ??= this.deps.signature().catch(() => null);
    return this.signing;
  }

  private set(state: KeychainStatus["state"]): void {
    if (this.state === state) return;
    this.state = state;
    this.changed();
  }

  private changed(): void {
    const status = this.status();
    this.deps.onChange(status);
    for (const listener of this.listeners) listener(status);
  }
}

function asked(): { promise: Promise<boolean>; settle(open: boolean): void } {
  let settle: (open: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function settled(open: boolean) {
  return { promise: Promise.resolve(open), settle: () => {} };
}
