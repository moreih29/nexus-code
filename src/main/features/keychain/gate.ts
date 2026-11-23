/**
 * The macOS keychain the app's sealed files open with, read only when the
 * user knows it is coming.
 *
 * Reading the "NexusCode Safe Storage" item makes macOS ask for the login
 * password whenever the item's access list does not name the running app's
 * signature, as after the move to Developer ID. So, with sealed files there
 * and an app signed otherwise than when the keychain last opened, nothing is
 * read until the user says to go on (or does something that needs it); put
 * off, the files stay locked for the run. A call that runs long is macOS
 * asking, and the windows say what to choose meanwhile.
 */

import type { KeychainItem, KeychainStatus } from "../../../shared/keychain";
import { KeychainLockedError, type SecretBox } from "../remote/sealed-file";

/** What a feature with a sealed file needs of the keychain. */
export interface Keychain {
  /** What it seals with; null where the system has nothing to seal with. */
  readonly box: SecretBox | null;
  /** Resolves once it is known whether the user is asked first. */
  decided(): Promise<void>;
  /** Whether reads go ahead now; reads in the background wait while not. */
  isOpen(): boolean;
  /** Whether the item has a sealed file now. */
  has(item: KeychainItem): boolean;
  /**
   * For what the user does: opens the keychain, after the user's answer
   * while being asked first, and resolves whether it is open.
   */
  unlock(): Promise<boolean>;
  /**
   * A read in the background: runs now while open, otherwise once it opens,
   * resolving when it has run. A task waiting under the same key is
   * replaced; one the keychain refused waits for the next opening.
   */
  whenOpen(key: string, task: () => Promise<void>): Promise<void>;
}

/** The keychain as the app's windows and settings see it and answer it. */
export interface KeychainControl extends Keychain {
  status(): KeychainStatus;
  /** The user says to open it: the prompt's answer, or the settings' button. */
  open(): Promise<boolean>;
  /** The user puts it off for this run. */
  putOff(): void;
}

/** A call longer than this is macOS asking the user, not the keychain answering. */
export const KEYCHAIN_SLOW_MS = 500;

/**
 * Whether a safeStorage call failed because the keychain gave no key, not
 * because of the data. Chromium asks the keychain once a run: a key it did
 * not get (the prompt refused, or the keychain locked) leaves its encryptor
 * without one, so decrypting says "temporarily unavailable" and encrypting
 * fails outright. A damaged or foreign file fails to decrypt with the key
 * there, with another message.
 */
export function refusedByKeychain(call: "encrypt" | "decrypt", error: unknown): boolean {
  if (call === "encrypt") return true;
  return error instanceof Error && /temporarily unavailable/i.test(error.message);
}

/** Where nothing asks first (away from macOS): always open. */
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
    whenOpen: (key, task) => task().catch((error: unknown) => warn(`${key}: ${describe(error)}`)),
    status: () => ({ state: "open", items: [], busy: false, refused: false }),
    open: async () => true,
    putOff: () => {},
  };
}

export interface KeychainGateDeps {
  /** safeStorage's own calls. */
  readonly raw: Pick<SecretBox, "encrypt" | "decrypt">;
  /** The items with a sealed file now. */
  items(): KeychainItem[];
  /** The running app's signature; null where it cannot be told. */
  signature(): Promise<string | null>;
  /** The signature the keychain last opened for. */
  readonly recorded: { get(): string | null; set(signature: string): void };
  /** Told each time the status changes. */
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
  /** Calls running past KEYCHAIN_SLOW_MS. */
  private slow = 0;
  /** Refused in macOS's prompt: Chromium keeps the run's encryptor without a key, so opening again fails at once. */
  private refused = false;
  private readonly waiting = new Map<string, Waiting>();
  private readonly decision: Promise<void>;
  /** The answer, while the user is asked. */
  private answer: { promise: Promise<boolean>; settle(open: Promise<boolean> | boolean): void } =
    settled(false);
  private opening: Promise<boolean> | null = null;
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
    if (this.state === "locked") return this.openNow();
    return this.opening ?? Promise.resolve(true);
  }

  /** Leaves "ask" or "locked" at once, so no other window takes the question meanwhile. */
  open(): Promise<boolean> {
    if (this.refused) return Promise.resolve(false);
    if (this.state === "checking") return this.decision.then(() => this.open());
    if (this.state === "ask") {
      const opened = this.openNow();
      this.answer.settle(opened);
      return opened;
    }
    if (this.state === "locked") return this.openNow();
    return this.opening ?? Promise.resolve(true);
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
    void this.openNow();
  }

  /** Runs what waited; the first read asks macOS where it would. */
  private openNow(): Promise<boolean> {
    if (this.opening) return this.opening;
    this.set("opening");
    const tasks = [...this.waiting];
    this.waiting.clear();
    this.opening = Promise.all(
      tasks.map(async ([key, { task, done }]) => {
        await this.run(key, task);
        done();
      }),
    ).then(() => {
      this.opening = null;
      if (this.state === "opening") this.set("open");
      return this.state === "open";
    });
    return this.opening;
  }

  private async run(key: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (!(error instanceof KeychainLockedError)) {
        this.deps.warn?.(`${key}: ${describe(error)}`);
      } else if (!this.waiting.has(key)) {
        // Refused, or read before opening: again at the next opening.
        this.waiting.set(key, queued(task));
      }
    }
  }

  private async call<T>(kind: "encrypt" | "decrypt", work: () => Promise<T>): Promise<T> {
    // Nothing reads while closed: the features ask first, and this is the net.
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

  /** The keychain opened for this app: the next run need not ask while it is signed the same. */
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
    this.deps.onChange(this.status());
  }
}

function asked(): { promise: Promise<boolean>; settle(open: Promise<boolean> | boolean): void } {
  let settle: (open: Promise<boolean> | boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function settled(open: boolean) {
  return { promise: Promise.resolve(open), settle: () => {} };
}
