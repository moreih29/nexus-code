// An image in the chat, which a click shows in quick look, where it zooms,
// among the conversation's other images: as the file it is, when a tool
// read it from one; from its data otherwise. Outside a Claude or Codex tab
// it is a plain image.

import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { imageFileOf, imageSrc } from "../../services/chat/image-look";
import type { ImageBlock, ImageLoader, ToolCall } from "../../services/chat/model";
import { cn } from "../../utils/cn";
import { useChatLinks } from "./chat-links";

/**
 * Fetches an image whose bytes are elsewhere: another computer's chat's,
 * which comes without them. None in a chat here, whose images have theirs.
 */
export const ImageLoaderContext = createContext<ImageLoader | null>(null);

/** Resolve a remote ref under the current loader's peer connection. */
export function useImageBytes(image: ImageBlock | undefined): {
  image: ImageBlock | null;
  failed: boolean;
} {
  const load = useContext(ImageLoaderContext);
  const remote = image?.data === "" ? image.remote : undefined;
  const ref = remote ? JSON.stringify(remote) : null;
  const [got, setGot] = useState<{
    load: ImageLoader | null;
    ref: string | null;
    image: ImageBlock | null;
    failed: boolean;
  }>({ load, ref, image: null, failed: false });
  const current = got.ref === ref && got.load === load;
  if (!current) setGot({ load, ref, image: null, failed: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref identifies the image's bytes.
  useEffect(() => {
    if (!load || !image || !remote) return;
    let live = true;
    const show = (loaded: ImageBlock | null) => {
      if (!live) return;
      setGot((previous) =>
        previous.load === load &&
        previous.ref === ref &&
        previous.image === loaded &&
        previous.failed === (loaded === null)
          ? previous
          : { load, ref, image: loaded, failed: loaded === null },
      );
    };
    const off = load.subscribe(remote, show);
    void load(image).then(show, () => show(null));
    return () => {
      live = false;
      off();
    };
  }, [ref, load]);
  if (!remote) return { image: image ?? null, failed: false };
  if (!load) return { image: null, failed: true };
  return current ? got : { image: null, failed: false };
}

export function ChatImage({
  images,
  index,
  file,
  className,
}: {
  /** The images it is shown among, itself at `index`. */
  images: readonly ImageBlock[];
  index: number;
  /** The image file it is, as a tool read it. */
  file?: string;
  /** The image's size and frame. */
  className?: string;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const bytes = useImageBytes(images[index]);
  if (!images[index]) return null;
  const image = bytes.image;
  // Another computer's image, while it comes, or when it did not.
  if (!image) {
    return (
      <span
        role="img"
        aria-label={t("chat.links.look")}
        className={cn(
          "inline-block h-16 w-24 rounded-(--radius-control) bg-muted",
          !bytes.failed && "animate-pulse",
          className,
        )}
        data-testid="chat-image-pending"
      />
    );
  }
  const img = <img src={imageSrc(image)} alt="" className={className} />;
  if (!links) return img;
  return (
    <button
      type="button"
      onClick={() => (file ? links.openFile(file) : links.openImages(images, index))}
      aria-label={t("chat.links.look")}
      title={file}
      className="inline-flex max-w-full cursor-zoom-in rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid="chat-image"
    >
      {img}
    </button>
  );
}

/** Most thumbnails beside a line of calls. */
const MAX_THUMBS = 3;

/**
 * The images tool calls gave, as small thumbnails beside their line, each
 * opening in quick look as ChatImage does: a Read of an image file shows
 * it there, as the line says only what was read.
 */
export function ToolThumbs({ calls }: { calls: readonly (ToolCall | undefined)[] }) {
  const thumbs = calls
    .flatMap((tool) => {
      const images = tool?.result?.images ?? [];
      const file = tool ? imageFileOf(tool.input) : undefined;
      return images.map((_, index) => ({ images, index, file }));
    })
    .slice(0, MAX_THUMBS);
  if (thumbs.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-testid="chat-tool-thumbs">
      {thumbs.map(({ images, index, file }, i) => (
        <ChatImage
          // biome-ignore lint/suspicious/noArrayIndexKey: the calls' images keep their order
          key={i}
          images={images}
          index={index}
          file={file}
          className="h-5 max-w-8 rounded-sm border border-border object-cover"
        />
      ))}
    </span>
  );
}
