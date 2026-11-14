/**
 * The "/" menu: typing "/" in a note offers the blocks to add there, filtered
 * by what follows it; arrows and Enter pick one, Escape closes it.
 */
import { type Editor, Extension, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import i18n from "i18next";
import {
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListOrdered,
  Minus,
  Paperclip,
  PenLine,
  Quote,
  Type,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/utils/cn";

export interface SlashItem {
  id: string;
  icon: typeof Type;
  /** Words it is also found by, besides its label. */
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

export interface SlashMenuOptions {
  /** Asks for files to put into the note. */
  pickFiles: (editor: Editor) => void;
  /** Asks for images to put into the note. */
  pickImages: (editor: Editor) => void;
}

export function slashItems(options: SlashMenuOptions): SlashItem[] {
  const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
  return [
    {
      id: "text",
      icon: Type,
      keywords: "text paragraph 글 문단",
      run: (e, r) => chain(e, r).setParagraph().run(),
    },
    {
      id: "h1",
      icon: Heading1,
      keywords: "heading title 제목",
      run: (e, r) => chain(e, r).setHeading({ level: 1 }).run(),
    },
    {
      id: "h2",
      icon: Heading2,
      keywords: "heading 제목",
      run: (e, r) => chain(e, r).setHeading({ level: 2 }).run(),
    },
    {
      id: "h3",
      icon: Heading3,
      keywords: "heading 제목",
      run: (e, r) => chain(e, r).setHeading({ level: 3 }).run(),
    },
    {
      id: "todo",
      icon: CheckSquare,
      keywords: "todo task check 할일 체크",
      run: (e, r) => chain(e, r).toggleTaskList().run(),
    },
    {
      id: "bullets",
      icon: List,
      keywords: "list bullet 목록",
      run: (e, r) => chain(e, r).toggleBulletList().run(),
    },
    {
      id: "numbers",
      icon: ListOrdered,
      keywords: "list number ordered 번호",
      run: (e, r) => chain(e, r).toggleOrderedList().run(),
    },
    {
      id: "sketch",
      icon: PenLine,
      keywords: "sketch draw whiteboard 그림 화이트보드 그리기",
      run: (e, r) => chain(e, r).insertSketch().run(),
    },
    {
      id: "file",
      icon: Paperclip,
      keywords: "file attach 파일 첨부",
      run: (e, r) => {
        chain(e, r).run();
        options.pickFiles(e);
      },
    },
    {
      id: "image",
      icon: Image,
      keywords: "image picture photo 이미지 사진",
      run: (e, r) => {
        chain(e, r).run();
        options.pickImages(e);
      },
    },
    {
      id: "quote",
      icon: Quote,
      keywords: "quote 인용",
      run: (e, r) => chain(e, r).toggleBlockquote().run(),
    },
    {
      id: "code",
      icon: Code,
      keywords: "code 코드",
      run: (e, r) => chain(e, r).toggleCodeBlock().run(),
    },
    {
      id: "divider",
      icon: Minus,
      keywords: "divider rule hr 구분선",
      run: (e, r) => chain(e, r).setHorizontalRule().run(),
    },
  ];
}

const label = (id: string) => i18n.t(`notes:slash.${id}`);

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${label(item.id)} ${item.keywords}`.toLowerCase().includes(q));
}

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",
  addOptions: () => ({ pickFiles: () => {}, pickImages: () => {} }),
  addProseMirrorPlugins() {
    const items = slashItems(this.options);
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        items: ({ query }) => filterSlashItems(items, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(Menu, { props, editor: props.editor });
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                renderer?.destroy();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});

type MenuProps = SuggestionProps<SlashItem>;
interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const Menu = forwardRef<MenuHandle, MenuProps>(function Menu({ items, command, clientRect }, ref) {
  const [active, setActive] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new items (the query changed) start at the first
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[active];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));
  const rect = clientRect?.();
  if (!rect || !items.length) return null;
  const below = rect.bottom + 320 < window.innerHeight;
  return createPortal(
    <div
      className="fixed z-50 flex max-h-80 w-56 flex-col gap-px overflow-y-auto rounded-(--radius-control) border border-border bg-popover p-1 shadow-lg"
      style={
        below
          ? { left: rect.left, top: rect.bottom + 4 }
          : { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
      }
      role="listbox"
      data-testid="note-slash-menu"
    >
      <div className="px-2 pt-1 pb-0.5 text-app-micro text-muted-foreground">
        {i18n.t("notes:slash.title")}
      </div>
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === active}
            className={cn(
              "flex h-7 items-center gap-2 rounded-(--radius-control) px-2 text-left text-app-ui-sm text-foreground",
              i === active && "bg-[var(--sidebar-item-selected-bg)]",
            )}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              command(item);
            }}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {label(item.id)}
          </button>
        );
      })}
    </div>,
    document.body,
  );
});
