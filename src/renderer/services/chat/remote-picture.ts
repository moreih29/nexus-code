import { useEffect, useState } from "react";
import type { ChatMediaAccess, ImageBlock } from "./model";

type PictureListener = (image: ImageBlock | null) => void;

export function useRemotePicture(
  access: ChatMediaAccess | null | undefined,
  key: string | null,
  watch: (show: PictureListener) => (() => void) | undefined,
): { image: ImageBlock | null; failed: boolean } {
  const [got, setGot] = useState({ access, key, image: null as ImageBlock | null, failed: false });
  let shown = got;
  if (got.access !== access || got.key !== key) {
    const keep = access && access.scope === got.access?.scope && key === got.key;
    shown = { access, key, image: keep ? got.image : null, failed: false };
    setGot(shown);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: access and key identify the read and subscription.
  useEffect(() => {
    const signal = access?.signal;
    if (!signal || signal.aborted || key === null) return;
    let live = true;
    const off = watch((image) => {
      if (!live || signal.aborted) return;
      setGot((was) =>
        was.access !== access ||
        was.key !== key ||
        (was.image === image && was.failed === (image === null))
          ? was
          : { access, key, image, failed: image === null },
      );
    });
    return () => {
      live = false;
      off?.();
    };
  }, [access, key]);

  const unavailable = access !== undefined && !access?.signal;
  return { image: shown.image, failed: shown.failed || (unavailable && shown.image === null) };
}
