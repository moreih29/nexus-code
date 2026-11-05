// How a Claude tab opens what its conversation links: a file in quick
// look, the machine's own addresses in the app's browser, other sites in
// the system browser. A link's context menu opens it the other way, or
// copies it. Outside a Claude tab the links keep the plain behaviour.

import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { isLocalAddress } from "../../services/chat/links";
import { copyText } from "../../utils/clipboard";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
  type MenuItemSpec,
} from "../ui/context-menu";

export interface ChatLinks {
  /** Shows a file the conversation names, as written, in quick look. */
  openFile: (target: string) => void;
  /** Shows a file the session changed in quick look, as a diff. */
  openChange: (path: string) => void;
  /** Opens the file as a tab, beside the Claude tab when there is room. */
  openFileTab: (target: string) => void;
  /**
   * Opens an address: by default the machine's own in the app's browser
   * and others in the system browser; `other` swaps the two.
   */
  openUrl: (url: string, other?: boolean) => void;
}

export const ChatLinksContext = createContext<ChatLinks | null>(null);

export function useChatLinks(): ChatLinks | null {
  return useContext(ChatLinksContext);
}

/** A link with the menu that opens it the other way, or copies it. */
export function LinkMenu({
  target,
  kind,
  children,
}: {
  target: string;
  kind: "file" | "url";
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  if (!links) return children;
  const items: MenuItemSpec[] =
    kind === "file"
      ? [
          { kind: "item", label: t("chat.links.look"), onSelect: () => links.openFile(target) },
          {
            kind: "item",
            label: t("chat.links.open_tab"),
            onSelect: () => links.openFileTab(target),
          },
          { kind: "separator" },
          { kind: "item", label: t("chat.links.copy_path"), onSelect: () => copyText(target) },
        ]
      : [
          {
            kind: "item",
            label: isLocalAddress(target)
              ? t("chat.links.open_system")
              : t("chat.links.open_app_browser"),
            onSelect: () => links.openUrl(target, true),
          },
          { kind: "separator" },
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
