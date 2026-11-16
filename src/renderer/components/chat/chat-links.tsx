// How a Claude tab opens what its conversation links: a file in quick
// look, the machine's own addresses in the app's browser, other sites in
// the system browser. A link's context menu opens it the other way, or
// copies it. Outside a Claude tab the links keep the plain behaviour.

import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { isLocalAddress, type LineAt } from "../../services/chat/links";
import type { ImageBlock } from "../../services/chat/model";
import { copyText } from "../../utils/clipboard";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
  type MenuItemSpec,
} from "../ui/context-menu";

export interface ChatLinks {
  /**
   * Shows a file the conversation names, as written, in quick look: an
   * image among the conversation's images, any other file alone.
   */
  openFile: (target: string) => void;
  /**
   * Shows the image at `index` of `images`, with no file, as a tool or the
   * user gave it, in quick look among the conversation's images.
   */
  openImages: (images: readonly ImageBlock[], index: number) => void;
  /** Shows a file the session changed in quick look, alone, as a diff. */
  openChange: (path: string) => void;
  /**
   * Opens the file as a tab, beside the Claude tab when there is room, at
   * the line the target names or `at`. None in another computer's chat,
   * whose files open in quick look only.
   */
  openFileTab?: (target: string, at?: LineAt) => void;
  /**
   * Opens an address: by default the machine's own in the app's browser
   * and others in the system browser; `other` swaps the two.
   */
  openUrl: (url: string, other?: boolean) => void;
  /**
   * Addresses open one way only, with no other to offer: another
   * computer's chat, whose own addresses are that computer's.
   */
  urlsOneWay?: boolean;
}

/** A chat here's links, whose files open as tabs too. */
export type LocalChatLinks = ChatLinks & { openFileTab: NonNullable<ChatLinks["openFileTab"]> };

export const ChatLinksContext = createContext<ChatLinks | null>(null);

export function useChatLinks(): ChatLinks | null {
  return useContext(ChatLinksContext);
}

/**
 * A link with the menu that opens it the other way, or copies it. A file
 * opens as `href` names it, at its line; `target` is what is copied.
 */
export function LinkMenu({
  target,
  href = target,
  kind,
  children,
}: {
  target: string;
  href?: string;
  kind: "file" | "url";
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  if (!links) return children;
  const { openFileTab } = links;
  const items: MenuItemSpec[] =
    kind === "file"
      ? [
          { kind: "item", label: t("chat.links.look"), onSelect: () => links.openFile(href) },
          ...(openFileTab
            ? [
                {
                  kind: "item",
                  label: t("chat.links.open_tab"),
                  onSelect: () => openFileTab(href),
                } satisfies MenuItemSpec,
              ]
            : []),
          { kind: "separator" },
          { kind: "item", label: t("chat.links.copy_path"), onSelect: () => copyText(target) },
        ]
      : [
          ...(links.urlsOneWay
            ? []
            : [
                {
                  kind: "item",
                  label: isLocalAddress(target)
                    ? t("chat.links.open_system")
                    : t("chat.links.open_app_browser"),
                  onSelect: () => links.openUrl(target, true),
                } satisfies MenuItemSpec,
                { kind: "separator" } satisfies MenuItemSpec,
              ]),
          { kind: "item", label: t("chat.links.copy_link"), onSelect: () => copyText(target) },
        ];
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItems items={items} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
