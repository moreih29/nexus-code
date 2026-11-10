/**
 * What is kept once shown: hidden, it stays mounted under an Activity
 * boundary (display: none, its effects and store subscriptions let go of
 * until it shows again), so showing it is a reveal, not a remount. It
 * keeps its state, folds and scroll among them. Mounted the first time it
 * is shown, so what is never shown costs nothing.
 */

import { Activity, type ReactNode, useState } from "react";

export function KeptMounted({
  shown,
  children,
}: {
  shown: boolean;
  children: ReactNode;
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(shown);
  // Set while rendering, as a value derived from props is: no commit
  // without it.
  if (shown && !mounted) setMounted(true);
  if (!mounted && !shown) return null;
  return <Activity mode={shown ? "visible" : "hidden"}>{children}</Activity>;
}
