/**
 * Which input lets the app window open one link in the browser
 * (window.open, which main hands to the OS), like Chrome's popup blocker
 * but narrower: the window is the whole app, so the activation counts for
 * every frame in it, the HTML preview's page too. Keys typed into the
 * editor would let a previewed page's timer open links while the user
 * types, so of the keys only those that follow a link count: Enter and
 * Space, pressed, not held. A click or tap counts, and only briefly: a
 * link's click handler opens it at once.
 *
 * The HTML preview's page is a sandboxed srcdoc frame, which Chromium runs
 * in a process of its own: input-event never sees input in it, so a link
 * there would never open. before-input-event and before-mouse-event see the
 * keys and the mouse in every frame; input-event still gives a tap, in the
 * app's own frame (watchActivation).
 */

/** How long an activating input lets one window.open through. */
export const USER_ACTIVATION_MS = 1_000;

/** The keys (KeyboardEvent.key, as Electron gives it) that activate a focused link or button. */
const ACTIVATING_KEYS = new Set(["Enter", " "]);

/** One input as Electron's input-event, before-input-event or before-mouse-event gives it. */
export interface ActivationInput {
  readonly type: string;
  readonly key?: string;
  /** before-input-event's: the key is held down and repeats. */
  readonly isAutoRepeat?: boolean;
  /** "isautorepeat" among them, for input-event, when the key repeats. */
  readonly modifiers?: readonly string[];
}

/** Whether `input` lets a link open. */
export function activates(input: ActivationInput): boolean {
  switch (input.type) {
    case "mouseDown":
    // A click comes on the button's release, which a long press puts later.
    case "mouseUp":
    case "touchEnd":
    case "gestureTap":
      return true;
    case "keyDown":
    case "rawKeyDown":
      // A key held down repeats; only its first press follows a link.
      return input.key !== undefined && ACTIVATING_KEYS.has(input.key) && !repeats(input);
    default:
      return false;
  }
}

function repeats(input: ActivationInput): boolean {
  return (
    input.isAutoRepeat === true ||
    (input.modifiers?.some((m) => m.toLowerCase() === "isautorepeat") ?? false)
  );
}

/** The last activating input, which lets one window.open through for a moment. */
export class UserActivation {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Takes in one input. */
  note(input: ActivationInput): void {
    if (activates(input)) this.lastAt = this.now();
  }

  /** Whether a window.open may go through now; it uses up the input that let it. */
  take(): boolean {
    if (this.now() - this.lastAt > USER_ACTIVATION_MS) return false;
    this.lastAt = Number.NEGATIVE_INFINITY;
    return true;
  }
}

type InputListener = (event: unknown, input: ActivationInput) => void;

/** The window's webContents, as watchActivation listens to it. */
export interface ActivationSource {
  on(event: "before-input-event", listener: InputListener): unknown;
  on(event: "before-mouse-event", listener: InputListener): unknown;
  on(event: "input-event", listener: InputListener): unknown;
}

/** Notes in `activation` the input in every frame of `contents`. */
export function watchActivation(contents: ActivationSource, activation: UserActivation): void {
  // Keys and the mouse in any frame, the out-of-process preview's too.
  contents.on("before-input-event", (_event, input) => activation.note(input));
  contents.on("before-mouse-event", (_event, input) => activation.note(input));
  // A tap, which neither of those gives.
  contents.on("input-event", (_event, input) => {
    if (input.type === "touchEnd" || input.type === "gestureTap") activation.note(input);
  });
}
