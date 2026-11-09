// An image in the chat, which a click shows in quick look, where it zooms,
// among the conversation's other images: as the file it is, when a tool
// read it from one; from its data otherwise. Outside a Claude or Codex tab
// it is a plain image.

import { useTranslation } from "react-i18next";
import { imageFileOf, imageSrc } from "../../services/chat/image-look";
import type { ImageBlock, ToolCall } from "../../services/chat/model";
import { useChatLinks } from "./chat-links";

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
  const image = images[index];
  if (!image) return null;
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
