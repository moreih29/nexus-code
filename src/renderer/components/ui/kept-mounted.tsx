import { Activity, type ReactNode, useState } from "react";

export function KeptMounted({
  shown,
  children,
}: {
  shown: boolean;
  children: ReactNode;
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(shown);
  if (shown && !mounted) setMounted(true);
  if (!mounted && !shown) return null;
  return <Activity mode={shown ? "visible" : "hidden"}>{children}</Activity>;
}
