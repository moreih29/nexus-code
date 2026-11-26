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
import type { LinkedFile } from "../../services/chat/chat-files";
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

export type OpenFileOptions =
  | { gallery?: string[]; link?: LinkedFile; links?: Readonly<Record<string, LinkedFile>> }
  | { draft: File };

export interface ChatLinks {
  openFile: (target: string, options?: OpenFileOptions) => void;
  openImages: (images: readonly ImageBlock[], index: number) => void;
  opensAttached?: (target: string) => boolean;
  openChange: (path: string) => void;
  openFileTab?: (target: string, at?: LineAt) => void;
  openUrl: (url: string, other?: boolean) => void;
  urlsOneWay?: boolean;
}

export type LocalChatLinks = ChatLinks & { openFileTab: NonNullable<ChatLinks["openFileTab"]> };

export const ChatLinksContext = createContext<ChatLinks | null>(null);

export function useChatLinks(): ChatLinks | null {
  return useContext(ChatLinksContext);
}

export type PlacesOf = (target: string, cwd: string) => FileLink[];

export const LinkPlacesContext = createContext<PlacesOf | null>(null);

const onePlace: PlacesOf = (target, cwd) => {
  const link = resolveFileLink(target, cwd);
  return link ? [link] : [];
};

export function useLinkPlaces(): PlacesOf {
  return useContext(LinkPlacesContext) ?? onePlace;
}

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

interface LinkMenuFor {
  readonly links: ChatLinks;
  readonly target: string;
  readonly href: string;
  readonly kind: "file" | "url";
  readonly link?: LinkedFile;
}

let openLinkMenu: ((link: LinkMenuFor, at: { x: number; y: number }) => void) | null = null;

export function LinkMenu({
  target,
  href = target,
  kind,
  link: linked,
  children,
}: {
  target: string;
  href?: string;
  kind: "file" | "url";
  link?: LinkedFile;
  children: React.ReactElement;
}) {
  const links = useChatLinks();
  if (!links) return children;
  const link = children as React.ReactElement<{ onContextMenu?: React.MouseEventHandler }>;
  const own = link.props.onContextMenu;
  return cloneElement(link, {
    onContextMenu: (event: React.MouseEvent) => {
      own?.(event);
      if (event.defaultPrevented || !openLinkMenu) return;
      event.preventDefault();
      openLinkMenu(
        { links, target, href, kind, ...(linked ? { link: linked } : {}) },
        { x: event.clientX, y: event.clientY },
      );
    },
  });
}

export function LinkMenuRoot() {
  const { t } = useTranslation();
  const [shown, setShown] = useState<LinkMenuFor | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    openLinkMenu = (link, at) => {
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

function linkMenuItems(
  { links, target, href, kind, link }: LinkMenuFor,
  t: TFunction,
  look: (open: () => void) => void,
): MenuItemSpec[] {
  const { openFileTab } = links;
  return kind === "file"
    ? [
        {
          kind: "item",
          label: t("chat.links.look"),
          onSelect: () => look(() => links.openFile(href, link ? { link } : undefined)),
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
