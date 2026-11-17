// How a Claude tab opens what its conversation links: a file in quick
// look, the machine's own addresses in the app's browser, other sites in
// the system browser. A link's context menu opens it the other way, or
// copies it. Outside a Claude tab the links keep the plain behaviour.

import type { TFunction } from "i18next";
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { type LinkPlaceIndex, linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import {
  type FileLink,
  isLocalAddress,
  type LineAt,
  resolveFileLink,
} from "../../services/chat/links";
import type { ImageBlock, ToolCall } from "../../services/chat/model";
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
 * The files a link a reply wrote in `cwd` may name, the likeliest first
 * (link-places): from the chat's folder, and from where its agent's shell
 * went.
 */
export type PlacesOf = (target: string, cwd: string) => FileLink[];

/** A conversation's PlacesOf, for the replies it shows. */
export const LinkPlacesContext = createContext<PlacesOf | null>(null);

/** Outside a conversation, a link names the one file it does from its folder. */
const onePlace: PlacesOf = (target, cwd) => {
  const link = resolveFileLink(target, cwd);
  return link ? [link] : [];
};

/** The places a reply's links may name, as the conversation it is in tells them. */
export function useLinkPlaces(): PlacesOf {
  return useContext(LinkPlacesContext) ?? onePlace;
}

/**
 * PlacesOf for a conversation of `tools`, as they are when a link is
 * looked at; the same function throughout, so what shows a link is not
 * drawn again each time a tool changes.
 */
export function usePlacesOf(tools: Readonly<Record<string, ToolCall>>): PlacesOf {
  const latest = useRef(tools);
  latest.current = tools;
  return useMemo(() => {
    let kept: { tools: Readonly<Record<string, ToolCall>>; index: LinkPlaceIndex } | null = null;
    return (target, cwd) => {
      const tools = latest.current;
      if (kept?.tools !== tools || kept.index.cwd !== cwd) {
        kept = { tools, index: linkPlaceIndex(tools, cwd) };
      }
      return linkPlaces(target, kept.index);
    };
  }, []);
}

/** The link a menu is open for, in the chat whose links open it. */
interface LinkMenuFor {
  readonly links: ChatLinks;
  readonly target: string;
  readonly href: string;
  readonly kind: "file" | "url";
}

/** What the root mounted to open the links' menu, while it is mounted. */
let openLinkMenu: ((link: LinkMenuFor, at: { x: number; y: number }) => void) | null = null;

/**
 * A link with the menu that opens it the other way, or copies it. A file
 * opens as `href` names it, at its line; `target` is what is copied.
 *
 * The menu is LinkMenuRoot's, one for every link: a menu of its own on
 * each link of a conversation cost a Radix menu per link, drawn again with
 * each chunk of a streaming reply.
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
  const links = useChatLinks();
  if (!links) return children;
  // The menu's trigger was the link itself (asChild), so the link takes the handler.
  const link = children as React.ReactElement<{ onContextMenu?: React.MouseEventHandler }>;
  const own = link.props.onContextMenu;
  return cloneElement(link, {
    onContextMenu: (event: React.MouseEvent) => {
      own?.(event);
      if (event.defaultPrevented || !openLinkMenu) return;
      event.preventDefault();
      openLinkMenu({ links, target, href, kind }, { x: event.clientX, y: event.clientY });
    },
  });
}

/**
 * The menu of every chat link, mounted once at the app's root. A link's
 * right-click hands it the link and the pointer; it opens there as the
 * link's own context menu did.
 */
export function LinkMenuRoot() {
  const { t } = useTranslation();
  const [shown, setShown] = useState<LinkMenuFor | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  // Quick look opens once the menu, closed, gave the focus back to the link:
  // opened before, it lost the focus to it and closed, and it gives the focus
  // back, when it closes, to where it was when it opened.
  const afterClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    openLinkMenu = (link, at) => {
      // The link's items first, then the menu opens at the pointer as a
      // context menu does: from a right-click on its trigger.
      flushSync(() => setShown(link));
      triggerRef.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: at.x,
          clientY: at.y,
        }),
      );
    };
    return () => {
      openLinkMenu = null;
    };
  }, []);
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger>
        <span ref={triggerRef} aria-hidden className="pointer-events-none fixed size-0" />
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={() => {
          const run = afterClose.current;
          afterClose.current = null;
          run?.();
        }}
      >
        <ContextMenuItems
          items={
            shown
              ? linkMenuItems(shown, t, (look) => {
                  afterClose.current = look;
                })
              : []
          }
        />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

/** A link's menu: open it the other way, or copy it. `look` is handed quick look to open. */
function linkMenuItems(
  { links, target, href, kind }: LinkMenuFor,
  t: TFunction,
  look: (open: () => void) => void,
): MenuItemSpec[] {
  const { openFileTab } = links;
  return kind === "file"
    ? [
        {
          kind: "item",
          label: t("chat.links.look"),
          onSelect: () => look(() => links.openFile(href)),
        },
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
}
