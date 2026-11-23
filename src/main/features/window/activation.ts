export const USER_ACTIVATION_MS = 1_000;

export const APP_ACTIVATION_MS = 5_000;

const ACTIVATING_KEYS = new Set(["Enter", " "]);

export interface ActivationInput {
  readonly type: string;
  readonly key?: string;
  readonly isAutoRepeat?: boolean;
  readonly modifiers?: readonly string[];
}

export function activates(input: ActivationInput): boolean {
  switch (input.type) {
    case "mouseDown":
    case "mouseUp":
    case "touchEnd":
    case "gestureTap":
      return true;
    case "keyDown":
    case "rawKeyDown":
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

export class UserActivation {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = USER_ACTIVATION_MS,
  ) {}

  note(input: ActivationInput): void {
    if (activates(input)) this.lastAt = this.now();
  }

  take(windowMs: number = this.windowMs): boolean {
    if (this.now() - this.lastAt > windowMs) return false;
    this.lastAt = Number.NEGATIVE_INFINITY;
    return true;
  }
}

type InputListener = (event: unknown, input: ActivationInput) => void;

export interface ActivationSource {
  on(event: "before-input-event", listener: InputListener): unknown;
  on(event: "before-mouse-event", listener: InputListener): unknown;
  on(event: "input-event", listener: InputListener): unknown;
}

export function watchActivation(contents: ActivationSource, activation: UserActivation): void {
  contents.on("before-input-event", (_event, input) => activation.note(input));
  contents.on("before-mouse-event", (_event, input) => activation.note(input));
  contents.on("input-event", (_event, input) => {
    if (input.type === "touchEnd" || input.type === "gestureTap") activation.note(input);
  });
}

export function opensHere(previewLink: boolean, keyboardInApp: boolean): boolean {
  return previewLink !== keyboardInApp;
}
