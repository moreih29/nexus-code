// Where the user writes to Claude: the message box, its images, the
// messages held for the turn's end, and the chips that switch the session's
// model, effort and permission mode.
//
// ↩ sends, and during a turn Claude reads it after the current tool; ⌘↩
// holds it until the turn ends; ⇧↩ breaks the line; esc stops the turn.
// A `/` at the start completes a command, an `@` a file.
//
// An attached file is sent as an @-mention of its path, which the CLI
// reads without asking. Where the program cannot see the file (an SSH
// host, a file with no path here) the agent writes it first.

import { AtSign, FileText, Paperclip, Pencil, Plus, Send, Slash, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { appCommandsBeside } from "../../services/chat/app-commands";
import {
  applyCompletion,
  completionAt,
  fileMention,
  isFolder,
  matchCommands,
} from "../../services/chat/composer-input";
import type { ChatController } from "../../services/chat/controller";
import type { ImageBlock, ModelInfo } from "../../services/chat/model";
import type { ChatTabState } from "../../services/chat/store";
import { firstVersionOf } from "../../services/chat/versions";
import { cn } from "../../utils/cn";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { type CompletionItem, CompletionMenu } from "./completion-menu";

interface ComposerProps {
  controller: ChatController;
  state: ChatTabState;
  /** The program runs on this machine, where an attached file's path can be read. */
  local: boolean;
  /** In place of the keys' hint: while an agent is shown, where input goes. */
  placeholder?: string;
  /** Above the queue: what an app command shows. */
  above?: React.ReactNode;
  /** Runs the message when it is one of the tab's own commands; false sends it. */
  onCommand?: (text: string) => boolean;
}

type ChipProps = Pick<ComposerProps, "controller" | "state">;

/** A file attached to the message, sent as a mention of its path. */
interface Attachment {
  id: number;
  file: File;
  /** Its path on this machine, which a local program reads as it is. */
  path?: string;
}

/** The API's limit on one image, before base64. */
const MAX_IMAGE_BYTES = 3_750_000;
/** The agent's limit on one attached file it writes. */
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
/** How long typing pauses before the CLI is asked for files. */
const SUGGEST_DELAY_MS = 100;
/** When to ask again after no files: the CLI's index may have been cold. */
const SUGGEST_RETRY_MS = 500;

let nextAttachmentId = 1;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ROWS_PX = 240;

export function Composer({
  controller,
  state,
  local,
  placeholder,
  above,
  onCommand,
}: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageBlock[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { model, phase } = state;
  const running = model.running;
  const blocked = phase === "not-found" || phase === "held" || phase === "starting";
  const hasText = text.trim() !== "" || images.length > 0 || files.length > 0;
  const canSend = !blocked && hasText && !sending;

  // The caret, for the token it completes; a pick moves it after the render.
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    const area = areaRef.current;
    if (at === null || !area) return;
    pendingCaret.current = null;
    area.setSelectionRange(at, at);
    setCaret(at);
  });
  const edit = (next: string, at: number) => {
    setText(next);
    pendingCaret.current = at;
    areaRef.current?.focus();
  };

  const completion = completionAt(text, caret);
  const completionKey = completion ? `${completion.kind}:${completion.start}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const menuOpen = focused && completion !== null && completionKey !== dismissed;
  const commands = useMemo(() => {
    if (!menuOpen || completion?.kind !== "command") return [];
    const cli = model.init?.commands ?? [];
    const own = appCommandsBeside(cli, (name) => t(`chat.commands.describe.${name}`));
    return matchCommands([...cli, ...own], completion.query);
  }, [menuOpen, completion?.kind, completion?.query, model.init, t]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const fileQuery = menuOpen && completion?.kind === "file" ? completion.query : null;
  useEffect(() => {
    if (fileQuery === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (again: boolean) => {
      controller
        .fileSuggestions(fileQuery)
        .then((paths) => {
          if (!live) return;
          setSuggested(paths);
          // The CLI answers nothing while it first lists the folder's files.
          if (paths.length === 0 && again) timer = setTimeout(() => ask(false), SUGGEST_RETRY_MS);
        })
        .catch(() => {});
    };
    timer = setTimeout(() => ask(true), SUGGEST_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [fileQuery, controller]);
  const items: CompletionItem[] =
    completion?.kind === "command"
      ? commands.map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          hint: c.argumentHint || undefined,
          detail: c.description,
          icon: "command" as const,
        }))
      : fileQuery !== null
        ? suggested.map((path) => ({
            key: path,
            label: path,
            icon: isFolder(path) ? ("folder" as const) : ("file" as const),
          }))
        : [];
  const [active, setActive] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new token or query starts at the top
  useEffect(() => setActive(0), [completionKey, completion?.query]);

  const pick = (index: number) => {
    if (!completion) return;
    const item = items[index];
    if (!item) return;
    const next = applyCompletion(
      text,
      completion,
      completion.kind === "command"
        ? { kind: "command", name: item.key }
        : { kind: "file", path: item.key },
    );
    edit(next.text, next.caret);
  };

  /** Types a `/` or `@` at the caret, from the + menu. */
  const insertTrigger = (trigger: "/" | "@") => {
    if (trigger === "/") {
      edit(text.startsWith("/") ? text : `/${text}`, 1);
      return;
    }
    const at = Math.min(caret, text.length);
    const space = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
    edit(`${text.slice(0, at)}${space}@${text.slice(at)}`, at + space.length + 1);
  };

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_ROWS_PX)}px`;
  });

  const clear = () => {
    setText("");
    setImages([]);
    setFiles([]);
  };

  /** The message with its attached files' mentions after the text. */
  const withAttachments = async (): Promise<string> => {
    if (files.length === 0) return text;
    const paths = await Promise.all(
      files.map(
        async (attachment) =>
          attachment.path ??
          controller.attach(attachment.file.name, await base64Of(attachment.file)),
      ),
    );
    const mentions = paths.map(fileMention).join(" ");
    return text.trim() ? `${text}\n\n${mentions}` : mentions;
  };

  const submit = async (queue: boolean) => {
    if (!canSend) return;
    if (images.length === 0 && files.length === 0 && onCommand?.(text)) {
      clear();
      return;
    }
    let message: string;
    setSending(true);
    try {
      message = await withAttachments();
    } catch (err) {
      showError(err as Error);
      return;
    } finally {
      setSending(false);
    }
    if (queue && running) controller.enqueue(message, images);
    else void controller.send(message, images).catch((err: Error) => showError(err));
    clear();
  };

  const addFiles = useCallback(
    async (picked: Iterable<File>) => {
      const added: ImageBlock[] = [];
      const attached: Attachment[] = [];
      for (const file of picked) {
        if (IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES) {
          added.push({ mediaType: file.type, data: await base64Of(file) });
          continue;
        }
        const path = local ? window.files.getPathForFile(file) || undefined : undefined;
        if (!path && file.size > MAX_ATTACH_BYTES) {
          showToast({
            kind: "warning",
            message: t("chat.composer.file_too_large", { name: file.name }),
          });
          continue;
        }
        attached.push({ id: nextAttachmentId++, file, path });
      }
      if (added.length > 0) setImages((prev) => [...prev, ...added]);
      if (attached.length > 0) setFiles((prev) => [...prev, ...attached]);
    },
    [t, local],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen && items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + items.length) % items.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(completionKey);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      void controller.interrupt().catch((err: Error) => showError(err));
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length === 0) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void addFiles([...e.dataTransfer.files]);
    areaRef.current?.focus();
  };

  // A rewound or forked message comes back here, after what is already typed.
  const draft = state.draft;
  const tookDraft = useRef(0);
  useEffect(() => {
    if (!draft || draft.nonce === tookDraft.current) return;
    tookDraft.current = draft.nonce;
    setText((prev) => (prev ? `${prev}\n${draft.text}` : draft.text));
    setImages((prev) => [...prev, ...draft.images]);
    areaRef.current?.focus();
    controller.clearDraft();
  }, [draft, controller]);

  const pullBack = (id: string) => {
    const item = controller.removeQueued(id);
    if (!item) return;
    setText((prev) => (prev ? `${prev}\n${item.text}` : item.text));
    setImages((prev) => [...prev, ...item.images]);
    areaRef.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-border px-4 pt-2 pb-3" data-testid="chat-composer">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">
        {above}
        {state.queue.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label={t("chat.queue.aria")}>
            {state.queue.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-(--radius-control) bg-muted px-2 py-1 text-app-ui-sm"
              >
                <span className="shrink-0 text-app-micro text-muted-foreground">
                  {t("chat.queue.label")}
                </span>
                <span className="min-w-0 flex-1 truncate" title={item.text}>
                  {item.text || t("chat.queue.images", { count: item.images.length })}
                </span>
                <IconButton label={t("chat.queue.edit")} onClick={() => pullBack(item.id)}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label={t("chat.queue.remove")}
                  onClick={() => controller.removeQueued(item.id)}
                >
                  <X className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: files dropped on the box are attached */}
        <div
          className="relative rounded-(--radius-raised) border border-border bg-background focus-within:border-ring"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={onDrop}
        >
          {menuOpen && completion && (
            <CompletionMenu
              kind={completion.kind}
              items={items}
              active={active}
              onPick={pick}
              onHover={setActive}
            />
          )}
          {(images.length > 0 || files.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {images.map((image, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: attachments keep their order
                  key={i}
                  className="group/img relative"
                >
                  <img
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt=""
                    className="size-14 rounded-(--radius-control) border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    title={t("chat.composer.remove_image")}
                    aria-label={t("chat.composer.remove_image")}
                    className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-popover p-0.5 opacity-0 group-hover/img:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {files.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex h-14 max-w-56 items-center gap-1.5 rounded-(--radius-control) border border-border px-2 text-app-ui-sm"
                  title={attachment.path ?? attachment.file.name}
                  data-testid="chat-attachment"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{attachment.file.name}</div>
                    <div className="text-app-micro text-muted-foreground">
                      {formatSize(attachment.file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((f) => f.id !== attachment.id))}
                    title={t("chat.composer.remove_file")}
                    aria-label={t("chat.composer.remove_file")}
                    className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={areaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={sending}
            rows={1}
            placeholder={
              placeholder ??
              (running ? t("chat.composer.placeholder_running") : t("chat.composer.placeholder"))
            }
            aria-label={t("chat.composer.aria")}
            className="app-scrollbar block w-full resize-none bg-transparent px-3 py-2 text-app-body outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <ModeChip controller={controller} state={state} />
            <ModelChip controller={controller} state={state} />
            <EffortChip controller={controller} state={state} />
            <div className="flex-1" />
            <AddMenu
              onAttach={() => fileRef.current?.click()}
              onMention={
                controller.supports("file_suggestions")
                  ? () => insertTrigger("@")
                  : t("chat.panel.needs_version", { version: firstVersionOf("file_suggestions") })
              }
              onCommand={
                (model.init?.commands.length ?? 0) > 0 ? () => insertTrigger("/") : undefined
              }
              returnFocus={() => areaRef.current?.focus()}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles([...e.target.files]);
                e.target.value = "";
              }}
            />
            {running && (
              <IconButton
                label={t("chat.composer.stop")}
                onClick={() => void controller.interrupt().catch((err: Error) => showError(err))}
                disabled={model.interrupting}
              >
                <Square className="size-3.5 fill-current" />
              </IconButton>
            )}
            {/* During a turn an empty box offers only stop; with text, both. */}
            {(!running || hasText) && (
              <IconButton
                label={running ? t("chat.composer.send_now") : t("chat.composer.send")}
                onClick={() => void submit(false)}
                disabled={!canSend}
                primary
              >
                <Send className="size-4" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function showError(err: Error): void {
  showToast({ kind: "error", message: err.message });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** The + menu: attach a file, mention one, or start a command. */
function AddMenu({
  onAttach,
  onMention,
  onCommand,
  returnFocus,
}: {
  onAttach: () => void;
  /** Puts an @ in; a note in its place says why it can't. */
  onMention: (() => void) | string;
  onCommand?: () => void;
  returnFocus: () => void;
}) {
  const { t } = useTranslation();
  const typed = useRef(false);
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          title={t("chat.composer.add")}
          aria-label={t("chat.composer.add")}
          className="rounded-(--radius-control) p-1.5 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          data-testid="chat-add-menu"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        onCloseAutoFocus={(event) => {
          // A typed trigger leaves the caret where it put it.
          if (typed.current) {
            event.preventDefault();
            typed.current = false;
            returnFocus();
          }
        }}
      >
        <DropdownMenuItem onSelect={onAttach}>
          <Paperclip className="size-3.5" />
          {t("chat.composer.attach_file")}
        </DropdownMenuItem>
        {typeof onMention === "string" ? (
          <DropdownMenuItem disabled onSelect={() => {}}>
            <AtSign className="size-3.5" />
            <span className="flex flex-col">
              {t("chat.composer.mention_file")}
              <span className="text-app-micro text-muted-foreground">{onMention}</span>
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              typed.current = true;
              onMention();
            }}
          >
            <AtSign className="size-3.5" />
            {t("chat.composer.mention_file")}
            <DropdownMenuShortcut>@</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onCommand && (
          <DropdownMenuItem
            onSelect={() => {
              typed.current = true;
              onCommand();
            }}
          >
            <Slash className="size-3.5" />
            {t("chat.composer.command")}
            <DropdownMenuShortcut>/</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function IconButton({
  label,
  onClick,
  disabled,
  primary,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "rounded-(--radius-control) p-1.5 disabled:pointer-events-none disabled:opacity-40",
        primary
          ? "bg-primary text-primary-foreground hover:opacity-90"
          : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const CHIP_CLASS =
  "flex items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** Permission modes in the order the chip lists them; keys 1 to 5 pick them. */
const MODES = ["auto", "default", "acceptEdits", "plan"] as const;
const BYPASS = "bypassPermissions";
const ALL_MODES = [...MODES, BYPASS];

/** Tabs whose user has seen bypass mode's warning in this window. */
const bypassConfirmed = new Set<string>();

function ModeChip({ controller, state }: ChipProps) {
  const { t } = useTranslation();
  const mode = state.model.permissionMode ?? "default";
  const ready = state.model.process === "running";
  const blocked = state.model.bypassBlocked !== undefined;
  const [open, setOpen] = useState(false);
  const pick = async (next: string) => {
    if (next === mode || (next === BYPASS && blocked)) return;
    if (next === BYPASS && !bypassConfirmed.has(controller.key)) {
      const ok = await showConfirmDialog({
        title: t("chat.mode.bypass_confirm_title"),
        description: t("chat.mode.bypass_confirm_body"),
        confirmLabel: t("chat.mode.bypass_confirm"),
        variant: "destructive",
      });
      if (!ok) return;
      bypassConfirmed.add(controller.key);
    }
    controller.setPermissionMode(next).catch((err: Error) => showError(err));
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const next = ALL_MODES[Number(e.key) - 1];
      if (!next || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      void pickRef.current(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <button
          type="button"
          className={cn(CHIP_CLASS, mode === BYPASS && "text-destructive hover:text-destructive")}
          disabled={!ready}
          title={t("chat.mode.aria")}
          aria-label={t("chat.mode.aria")}
        >
          {t(`chat.mode.${mode}`, { defaultValue: mode })}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLabel>{t("chat.mode.label")}</DropdownMenuLabel>
        {MODES.map((m, i) => (
          <DropdownMenuItem key={m} onSelect={() => void pick(m)}>
            <span className="flex flex-col">
              <span className={cn(m === mode && "font-medium")}>{t(`chat.mode.${m}`)}</span>
              <span className="text-app-micro text-muted-foreground">
                {t(`chat.mode.${m}_hint`)}
              </span>
            </span>
            <DropdownMenuShortcut>{i + 1}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={blocked} onSelect={() => void pick(BYPASS)}>
          <span className="flex flex-col" title={state.model.bypassBlocked}>
            <span className={cn("text-destructive", mode === BYPASS && "font-medium")}>
              {t(`chat.mode.${BYPASS}`)}
            </span>
            <span className="text-app-micro text-muted-foreground">
              {blocked ? t("chat.mode.bypass_blocked") : t(`chat.mode.${BYPASS}_hint`)}
            </span>
          </span>
          <DropdownMenuShortcut>{ALL_MODES.length}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/** The model info the session runs, as the CLI names it either way (alias or id). */
export function currentModelInfo(
  models: ModelInfo[],
  current: string | undefined,
): ModelInfo | undefined {
  // Before its first turn the session names no model: it runs the default.
  if (!current) return models.find((m) => m.value === "default");
  return (
    models.find((m) => m.value === current) ??
    models.find((m) => m.resolvedModel === current) ??
    models.find((m) => current.startsWith(m.value))
  );
}

function ModelChip({ controller, state }: ChipProps) {
  const { t } = useTranslation();
  const models = state.model.init?.models ?? [];
  const current = currentModelInfo(models, state.model.model);
  const label = current?.displayName ?? state.model.model ?? t("chat.model.default");
  const ready = state.model.process === "running" && models.length > 0;
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          className={CHIP_CLASS}
          disabled={!ready}
          title={t("chat.model.aria")}
          aria-label={t("chat.model.aria")}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLabel>{t("chat.model.label")}</DropdownMenuLabel>
        {models.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onSelect={() => controller.setModel(m.value).catch((err: Error) => showError(err))}
          >
            <span className={cn(m === current && "font-medium")}>{m.displayName ?? m.value}</span>
            {m.description && (
              <span className="ml-4 max-w-64 truncate text-app-micro text-muted-foreground">
                {m.description}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function EffortChip({ controller, state }: ChipProps) {
  const { t } = useTranslation();
  const models = state.model.init?.models ?? [];
  const levels = currentModelInfo(models, state.model.model)?.supportedEffortLevels ?? [];
  if (levels.length === 0) return null;
  const effort = state.model.effort;
  if (!controller.supports("apply_flag_settings")) {
    const note = t("chat.panel.needs_version", { version: firstVersionOf("apply_flag_settings") });
    return (
      <button
        type="button"
        className={CHIP_CLASS}
        disabled
        title={`${t("chat.effort.aria")} · ${note}`}
      >
        {effort ?? t("chat.effort.unset")}
      </button>
    );
  }
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          className={CHIP_CLASS}
          disabled={state.model.process !== "running"}
          title={t("chat.effort.aria")}
          aria-label={t("chat.effort.aria")}
        >
          {effort ?? t("chat.effort.unset")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLabel>{t("chat.effort.label")}</DropdownMenuLabel>
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => controller.setEffort(level).catch((err: Error) => showError(err))}
          >
            <span className={cn(level === effort && "font-medium")}>{level}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
