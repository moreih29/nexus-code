/**
 * True while an IME (Korean, Japanese, Chinese) is composing text. An Enter
 * or Escape keydown in that state belongs to the IME — it commits or cancels
 * the composition — and must not also submit or close the surrounding
 * control. On macOS Chromium the composing Enter is followed by a second,
 * plain Enter keydown, so acting on both submits twice.
 *
 * `keyCode === 229` covers Chromium builds that set `isComposing` late on
 * some keydowns (the same dual guard the keybinding dispatcher and xterm.js
 * use).
 */
export function isImeComposing(event: React.KeyboardEvent | KeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
