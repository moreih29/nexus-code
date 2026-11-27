import { useEffect, useState } from "react";

const pending = new Map<string, Promise<void>>();

function decode(src: string): Promise<void> {
  const existing = pending.get(src);
  if (existing) return existing;
  if (typeof window.Image !== "function") return Promise.resolve();
  const image = new window.Image();
  image.src = src;
  const loaded = (image.decode?.() ?? Promise.resolve()).finally(() => pending.delete(src));
  pending.set(src, loaded);
  return loaded;
}

export function useDecodedImageSrc(src: string | undefined, scope: string): string | undefined {
  const [shown, setShown] = useState({ scope, src });
  const replace = shown.scope !== scope || !shown.src || !src;
  const current = replace ? src : shown.src;
  if (replace && (shown.scope !== scope || shown.src !== src)) setShown({ scope, src });

  useEffect(() => {
    if (!src || !current || current === src) return;
    let live = true;
    const show = () => {
      if (live) setShown({ scope, src });
    };
    void decode(src).then(show, show);
    return () => {
      live = false;
    };
  }, [scope, src, current]);

  return current;
}
