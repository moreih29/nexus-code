/**
 * Which input lets the app window open one link in the browser
 * (window.open, which main hands to the OS), like Chrome's popup blocker
 * but narrower: the window is the whole app, so the activation counts for
 * every frame in it, the HTML preview's page too. Keys typed into the
 * editor would let a previewed page's timer open links while the user
 * types, so of the keys only those that follow a link count: Enter and
 * Space. A click or tap counts, and only briefly: a link's click handler
 * opens it at once.
 */

/** How long an activating input lets one window.open through. */
export const USER_ACTIVATION_MS = 1_000;

/** The keys (KeyboardEvent.key, as input-event gives it) that activate a focused link or button. */
const ACTIVATING_KEYS = new Set(["Enter", " "]);

/** Whether `input` (Electron's input-event) lets a link open. */
export function activates(input: { readonly type: string; readonly key?: string }): boolean {
  switch (input.type) {
    case "mouseDown":
    // A click comes on the button's release, which a long press puts later.
    case "mouseUp":
    case "touchEnd":
    case "gestureTap":
      return true;
    case "keyDown":
    case "rawKeyDown":
      return input.key !== undefined && ACTIVATING_KEYS.has(input.key);
    default:
      return false;
  }
}
