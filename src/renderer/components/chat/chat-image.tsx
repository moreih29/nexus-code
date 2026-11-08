// An image in the chat, which a click shows in quick look, where it zooms:
// as the file it is, when a tool read it from one, among the session's
// results; from its data otherwise, with the images beside it a step away.
// Outside a Claude or Codex tab it is a plain image.

import { useTranslation } from "react-i18next";
import { imageSrc } from "../../services/chat/image-look";
import type { ImageBlock } from "../../services/chat/model";
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
