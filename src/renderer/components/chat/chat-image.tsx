import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { imageFileOf, imageSrc } from "../../services/chat/image-look";
import {
  type ImageBlock,
  type ImageLoader,
  remoteImageKey,
  type ToolCall,
} from "../../services/chat/model";
import { useRemotePicture } from "../../services/chat/remote-picture";
import { cn } from "../../utils/cn";
import { useChatLinks } from "./chat-links";

export const ImageLoaderContext = createContext<ImageLoader | null>(null);

export function useImageBytes(image: ImageBlock | undefined): {
  image: ImageBlock | null;
  failed: boolean;
} {
  const load = useContext(ImageLoaderContext);
  const remote = image?.data === "" ? image.remote : undefined;
  const shown = useRemotePicture(
    load?.access ?? null,
    remote ? remoteImageKey(remote) : null,
    (show) => {
      if (!load || !image || !remote) return;
      const off = load.subscribe(remote, show);
      void load(image).then(show, () => show(null));
      return off;
    },
  );
  return remote ? shown : { image: image ?? null, failed: false };
}

export function ChatImage({
  images,
  index,
  file,
  className,
}: {
  images: readonly ImageBlock[];
  index: number;
  file?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const bytes = useImageBytes(images[index]);
  if (!images[index]) return null;
  const image = bytes.image;
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
      onClick={() => links.openImages(images, index)}
      aria-label={t("chat.links.look")}
      title={file}
      className="inline-flex max-w-full cursor-zoom-in rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid="chat-image"
    >
      {img}
    </button>
  );
}

const MAX_THUMBS = 3;

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
