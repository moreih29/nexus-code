import { useEffect, useState } from "react";
import { LinkGrantError, useChatFiles } from "../../../services/chat/chat-files";
import { imageSrc } from "../../../services/chat/image-look";
import type { ImageBlock } from "../../../services/chat/model";
import { ImageChip } from "../../chat/file-image";
import { useDecodedImageSrc } from "../../ui/use-decoded-image-src";

type Shown =
  | { path: string; image: ImageBlock }
  | { path: string; required: true }
  | { path: string; failed: true };

export function PeerFileImage({
  path,
  href,
  parent,
  alt,
  fallback,
  ...rest
}: {
  path: string;
  href: string;
  parent: string;
  alt: string;
  fallback: React.ReactNode;
} & Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">) {
  const files = useChatFiles();
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (!files) return;
    let live = true;
    const off = files.subscribePicture(path, (image) => {
      if (image) setShown({ path, image });
      else setShown((was) => (was?.path === path && "image" in was ? { path, failed: true } : was));
    });
    void files.picture(path).then(
      (image) => {
        if (live) setShown({ path, image });
      },
      (error: unknown) => {
        if (!live) return;
        setShown(
          error instanceof LinkGrantError && error.kind === "grant-required"
            ? { path, required: true }
            : { path, failed: true },
        );
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [files, path]);
  const current = files && shown?.path === path ? shown : null;
  const image = current
    ? "image" in current
      ? current.image
      : undefined
    : files?.knownPicture?.(path);
  const src = useDecodedImageSrc(
    image ? imageSrc(image) : undefined,
    JSON.stringify([files?.access?.scope, path]),
  );
  if (src) return <img {...rest} src={src} alt={alt} />;
  if (!files || !current) {
    return (
      <span
        className="inline-block h-24 w-36 animate-pulse rounded-(--radius-control) bg-muted align-top"
        data-testid="peer-file-image-pending"
      />
    );
  }
  if ("required" in current) {
    return <ImageChip path={path} link={{ href, source: { kind: "file", parent } }} />;
  }
  return <>{fallback}</>;
}
