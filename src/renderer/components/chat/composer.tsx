// Where the user writes to Claude: the message box, its images, the
// messages held for the turn's end, and the chips that switch the session's
// model, effort and permission mode.
//
// ↩ sends, and during a turn Claude reads it after the current tool; ⌘↩
// (Ctrl+↩ off the Mac) holds it until the turn ends; ⇧↩ breaks the line;
// esc stops the turn.
// A `/` at the start completes a command, an `@` a file.
//
// An attached file is sent as an @-mention of its path, which the CLI
// reads without asking. Where the program cannot see the file (an SSH
// host, a file with no path here) the agent writes it first.

import type { TFunction } from "i18next";
import {
  AtSign,
  FileText,
  ListPlus,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Slash,
  Square,
  X,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CHAT_MODES, type ModeSet } from "../../../shared/sessions/chat-modes";
import { appCommandsBeside, listedCommands } from "../../services/chat/app-commands";
import {
  applyCompletion,
  completionAt,
  fileMention,
  isFolder,
  matchCommands,
} from "../../services/chat/composer-input";
import {
  currentModelInfo,
  type ImageBlock,
  isWaiting,
  type UserItem,
} from "../../services/chat/model";
import {
  type ChatTabState,
  type QueuedMessage,
  type RevealPart,
  takeReveal,
} from "../../services/chat/store";
import { firstVersionOf } from "../../services/chat/versions";
import { cn } from "../../utils/cn";
import { isMac } from "../../utils/platform";
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
import { IconButton } from "../ui/icon-button";
import { Keycap } from "../ui/keycap";
import { showToast } from "../ui/toast";
import { type ChatAgent, ChatAgentContext, useAgentContext } from "./chat-agent";
import { type CompletionItem, CompletionMenu } from "./completion-menu";
import { maxTextHeight } from "./composer-height";

/** What the composer drives: a Claude tab's controller, or a Codex tab's. */
export interface ComposerController {
  readonly key: string;
  /** The permission modes the mode chip offers; Claude Code's when left out. */
  readonly modes?: ModeSet;
  send(text: string, images?: ImageBlock[]): Promise<void>;
  /**
   * During a turn, sends a message the program reads at once, where `send`
   * waits for the tool it runs (⌘⇧↩); left out where `send` does not wait.
   */
  sendNow?(text: string, images?: ImageBlock[]): Promise<void>;
  /** Has the program read at once the messages `send` left waiting (⌘⇧↩ with nothing typed). */
  readHeldNow?(): Promise<void>;
  enqueue(text: string, images?: ImageBlock[]): void;
  removeQueued(id: string): QueuedMessage | undefined;
  /**
   * Takes back a message sent during the turn that the program has not read:
   * true when it was dropped, false when it was read first. Left out where
   * a sent message cannot wait.
   */
  withdraw?(sentUuid: string): Promise<boolean>;
  interrupt(): Promise<unknown>;
  clearDraft(): void;
  attach(name: string, data: string): Promise<string>;
  fileSuggestions(query: string): Promise<string[]>;
  /** Whether the program answers a request the composer makes (Claude Code's names). */
  supports(subtype: string): boolean;
  setPermissionMode(mode: string): Promise<unknown>;
  setModel(model: string): Promise<unknown>;
  setEffort(level: string): Promise<unknown>;
}

interface ComposerProps {
  controller: ComposerController;
  state: ChatTabState;
  /** The program runs on this machine, where an attached file's path can be read. */
  local: boolean;
  /** What the empty box says: while an agent is shown, where input goes. */
  placeholder?: string;
  /** Above the queue: what an app command shows. */
  above?: React.ReactNode;
  /** Under the box: the context and the plan's usage. */
  below?: React.ReactNode;
  /** Runs the message when it is one of the tab's own commands; false sends it. */
  onCommand?: (text: string) => boolean;
  /** The `/` menu lists the Claude tab's own commands too. */
  appCommands?: boolean;
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
/**
 * Grows the text box with its text, from the two rows it starts at up to
 * its cap in the column the composer sits in (composer-height).
 */
function fitHeight(area: HTMLTextAreaElement, column: HTMLElement | null | undefined): void {
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight, maxTextHeight(column?.clientHeight ?? 0))}px`;
}

export function Composer({
  controller,
  state,
  local,
  placeholder,
  above,
  below,
  onCommand,
  appCommands = true,
}: ComposerProps) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const program = useContext(ChatAgentContext);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageBlock[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { model, phase } = state;
  const running = model.running;
  const blocked = phase === "not-found" || phase === "held" || phase === "starting";
  const hasText = text.trim() !== "" || images.length > 0 || files.length > 0;
  const canSend = !blocked && hasText && !sending;
  // Sent during the turn, not yet read: what ⌘⇧↩ with nothing typed hurries.
  const held = running && model.items.some((item) => item.kind === "user" && item.state === "sent");
  // Those wait above the box, where they can be taken back as the terminal's ↑ does.
  const waiting = useMemo(() => model.items.filter(isWaiting), [model.items]);
  const canWithdraw = !!controller.withdraw && controller.supports("cancel_async_message");
  const canTakeBack = state.queue.length > 0 || (canWithdraw && waiting.length > 0);
  const withdrawing = useRef(new Set<string>());

  // The row under the box leaves out what it must to stay on one line.
  const footerRef = useRef<HTMLDivElement>(null);
  // A chip whose menu is open, or asked for by a bare /model or /effort,
  // stays in the row however narrow it is.
  const [menuOf, setMenuOf] = useState<RevealPart | null>(null);
  const kept = (part: RevealPart) => state.reveal?.part === part || menuOf === part;
  const onMenu = (part: RevealPart) => (open: boolean) =>
    setMenuOf((now) => (open ? part : now === part ? null : now));
  const fit = useFitStep(
    footerRef,
    `${model.permissionMode}|${model.model}|${model.effort}|${model.init?.models.length}|${model.process}|${running}|${hasText}|${menuOf}|${state.reveal?.part}`,
  );

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
    const own = appCommands
      ? appCommandsBeside(cli, (name) => t(`chat.commands.describe.${name}`))
      : [];
    return matchCommands([...listedCommands(cli), ...own], completion.query);
  }, [menuOpen, completion?.kind, completion?.query, model.init, t, appCommands]);
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
    if (areaRef.current) fitHeight(areaRef.current, rootRef.current?.parentElement);
  });
  // A tab in the background lays out at no width, where the placeholder
  // wraps a word to a line: the height it got there is wrong once the tab
  // shows, so a new width fits it again. The cap follows the column's
  // height, so a panel resized taller or shorter fits it again too.
  useEffect(() => {
    const area = areaRef.current;
    const column = rootRef.current?.parentElement;
    if (!area) return;
    let width = area.clientWidth;
    let height = column?.clientHeight ?? 0;
    const observer = new ResizeObserver(() => {
      const nextHeight = column?.clientHeight ?? 0;
      if (area.clientWidth === width && nextHeight === height) return;
      width = area.clientWidth;
      height = nextHeight;
      fitHeight(area, column);
    });
    observer.observe(area);
    if (column) observer.observe(column);
    return () => observer.disconnect();
  }, []);

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

  /** send: as ↩ sends; queue: after the turn (⌘↩); now: read at once (⌘⇧↩). */
  const submit = async (how: "send" | "queue" | "now") => {
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
    if (how === "queue" && running) controller.enqueue(message, images);
    else if (how === "now" && running && controller.sendNow) {
      void controller.sendNow(message, images).catch((err: Error) => showError(err));
    } else void controller.send(message, images).catch((err: Error) => showError(err));
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
    // A request's card has the keys, which the box passes on to it.
    if (e.currentTarget.dataset.cardKeys !== undefined) return;
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
    // ↑ at the start of the box takes back the last queued message to edit,
    // as the terminals do (Claude Code's ↑, Codex's ⇧←); again, the one before.
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      canTakeBack &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0
    ) {
      e.preventDefault();
      takeBackLast();
      return;
    }
    if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) void submit("now");
      else if (held) void controller.readHeldNow?.().catch((err: Error) => showError(err));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.metaKey || e.ctrlKey ? "queue" : "send");
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

  /**
   * A message taken back into the box: before what is typed with the caret
   * left at the start (↑), else after it.
   */
  const putBack = (item: { text: string; images: ImageBlock[] }, before: boolean) => {
    if (before) {
      setText((prev) => (prev ? `${item.text}\n${prev}` : item.text));
      setImages((prev) => [...item.images, ...prev]);
      requestAnimationFrame(() => areaRef.current?.setSelectionRange(0, 0));
    } else {
      setText((prev) => (prev ? `${prev}\n${item.text}` : item.text));
      setImages((prev) => [...prev, ...item.images]);
      areaRef.current?.focus();
    }
  };

  /** Takes back a message the program has not read, into the box or away. */
  const takeBackWaiting = async (item: UserItem, into: "before" | "after" | "nowhere") => {
    const uuid = item.sentUuid;
    if (!uuid || !controller.withdraw || withdrawing.current.has(uuid)) return;
    withdrawing.current.add(uuid);
    try {
      if (!(await controller.withdraw(uuid))) {
        showToast({ kind: "info", message: t("chat.queue.already_read") });
      } else if (into !== "nowhere") {
        putBack(item, into === "before");
      }
    } catch (err) {
      showError(err as Error);
    } finally {
      withdrawing.current.delete(uuid);
    }
  };

  /** The last message waiting, the app's queue's first: ↑ again takes the one before. */
  const takeBackLast = () => {
    const last = state.queue[state.queue.length - 1];
    if (last) {
      const item = controller.removeQueued(last.id);
      if (item) putBack(item, true);
      return;
    }
    const sent = waiting.filter((item) => !withdrawing.current.has(item.sentUuid ?? ""));
    const lastSent = sent[sent.length - 1];
    if (lastSent && canWithdraw) void takeBackWaiting(lastSent, "before");
  };

  const pullBack = (id: string) => {
    const item = controller.removeQueued(id);
    if (item) putBack(item, false);
  };

  return (
    <div
      ref={rootRef}
      className="shrink-0 border-t border-border px-4 pt-2 pb-3"
      data-testid="chat-composer"
    >
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">
        {above}
        {(waiting.length > 0 || state.queue.length > 0) && (
          <ul className="flex flex-col gap-1" aria-label={t("chat.queue.aria")}>
            {waiting.map((item) => (
              <QueueRow
                key={item.key}
                label={t("chat.queue.label")}
                item={item}
                onEdit={canWithdraw ? () => void takeBackWaiting(item, "after") : undefined}
                onRemove={canWithdraw ? () => void takeBackWaiting(item, "nowhere") : undefined}
              />
            ))}
            {state.queue.map((item) => (
              <QueueRow
                key={item.id}
                label={t("chat.queue.after_turn")}
                item={item}
                onEdit={() => pullBack(item.id)}
                onRemove={() => controller.removeQueued(item.id)}
              />
            ))}
            {canTakeBack && (
              <li className="px-2 text-app-micro text-muted-foreground">
                {t("chat.queue.take_back")}
              </li>
            )}
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
                  <IconButton
                    label={t("chat.composer.remove_file")}
                    size="xs"
                    onClick={() => setFiles((prev) => prev.filter((f) => f.id !== attachment.id))}
                    className="rounded-full"
                  >
                    <X className="size-3" />
                  </IconButton>
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
            rows={2}
            placeholder={placeholder}
            aria-label={t("chat.composer.aria", agent)}
            className="app-scrollbar block w-full resize-none bg-transparent px-3 py-2 text-app-body outline-none placeholder:text-muted-foreground"
          />
          <div ref={footerRef} className="flex items-center gap-1 overflow-hidden px-1.5 pb-1.5">
            <ModeChip controller={controller} state={state} truncate={fit >= FIT.TRUNCATE_MODE} />
            {(fit < FIT.NO_MODEL || kept("model")) && (
              <ModelChip
                controller={controller}
                state={state}
                short={fit >= FIT.SHORT_MODEL}
                onMenu={onMenu("model")}
              />
            )}
            {(fit < FIT.NO_EFFORT || kept("effort")) && (
              <EffortChip controller={controller} state={state} onMenu={onMenu("effort")} />
            )}
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
                shortcut="Esc"
                size="md"
                onClick={() => void controller.interrupt().catch((err: Error) => showError(err))}
                disabled={model.interrupting}
              >
                <Square className="size-3.5 fill-current" />
              </IconButton>
            )}
            {/* During a turn an empty box offers only stop; with text, both. */}
            {(!running || hasText) && (
              <SendButton
                running={running}
                waits={!!controller.sendNow}
                program={program}
                onClick={() => void submit("send")}
                disabled={!canSend}
                keycap={fit < FIT.NO_KEYCAP}
              />
            )}
          </div>
        </div>
        {below}
      </div>
    </div>
  );
}

function showError(err: Error): void {
  showToast({ kind: "error", message: err.message });
}

/**
 * What the row under the box leaves out, step by step, when it is too
 * narrow for all of it: the model's name loses its note, the send button
 * its key, then the effort goes, then the model, and last the mode's name
 * is cut. The mode, the + menu and send always stay.
 */
const FIT = {
  SHORT_MODEL: 1,
  NO_KEYCAP: 2,
  NO_EFFORT: 3,
  NO_MODEL: 4,
  TRUNCATE_MODE: 5,
} as const;

/**
 * The step of FIT that lets `row` hold its content on one line: each
 * render it overflows at takes the next step, before it paints. A new
 * width, or a change of what `content` names, starts over from all of it.
 */
function useFitStep(row: RefObject<HTMLElement | null>, content: string): number {
  const [step, setStep] = useState(0);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const shownFor = useRef(content);
  useLayoutEffect(() => {
    if (shownFor.current !== content) {
      shownFor.current = content;
      if (step !== 0) {
        setStep(0);
        return;
      }
    }
    const el = row.current;
    if (el && step < FIT.TRUNCATE_MODE && el.scrollWidth > el.clientWidth) setStep(step + 1);
  });
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setStep(0);
      recheck();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [row]);
  return step;
}

/**
 * A chip's menu, open as the user opens it or as a bare command (/model,
 * /effort) asks; one that cannot open says why instead. `onMenu` hears it
 * open and close in the same update, so the row keeps the chip it opens.
 */
function useRevealedMenu(
  controller: ComposerController,
  state: ChatTabState,
  part: RevealPart,
  unavailable: string | null,
  onMenu: (open: boolean) => void,
): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onMenu(next);
  };
  const reveal = state.reveal?.part === part ? state.reveal.seq : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once
  useEffect(() => {
    if (reveal === undefined) return;
    takeReveal(controller.key, reveal);
    if (unavailable) showToast({ kind: "info", message: unavailable });
    else setOpen(true);
  }, [reveal]);
  return [open, setOpen];
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
        <IconButton label={t("chat.composer.add")} size="md" data-testid="chat-add-menu">
          <Plus className="size-4" />
        </IconButton>
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

/** A message above the box that waits, with its pencil and × where it can be taken back. */
function QueueRow({
  label,
  item,
  onEdit,
  onRemove,
}: {
  label: string;
  item: { text: string; images: readonly ImageBlock[] };
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 rounded-(--radius-control) bg-muted px-2 py-1 text-app-ui-sm">
      <span className="shrink-0 text-app-micro text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate" title={item.text}>
        {item.text || t("chat.queue.images", { count: item.images.length })}
      </span>
      {onEdit && (
        <IconButton label={t("chat.queue.edit")} size="md" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </IconButton>
      )}
      {onRemove && (
        <IconButton label={t("chat.queue.remove")} size="md" onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </li>
  );
}

/**
 * The box's main button, with the key that presses it. During a turn a
 * Claude tab's message waits for the call that runs, so it shows as queued;
 * a Codex tab's goes in at once. Its tooltip tells the other keys.
 */
function SendButton({
  running,
  waits,
  program,
  onClick,
  disabled,
  keycap,
}: {
  running: boolean;
  /** During a turn, the message waits for the current call (Claude's ↩). */
  waits: boolean;
  program: ChatAgent;
  onClick: () => void;
  disabled: boolean;
  /** Shows the ↩ key it answers to; left out in a narrow row. */
  keycap: boolean;
}) {
  const { t } = useTranslation();
  const queues = running && waits;
  const label = queues
    ? t("chat.composer.queue")
    : running
      ? t("chat.composer.send_now")
      : t("chat.composer.send");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={composerHint(t, running, program)}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-(--radius-control) bg-primary py-1.5 text-primary-foreground hover:opacity-90 disabled:pointer-events-none disabled:opacity-40",
        keycap ? "pr-1.5 pl-2" : "px-2",
      )}
      data-testid="chat-send"
    >
      {queues ? <ListPlus className="size-4" /> : <Send className="size-4" />}
      {keycap && <Keycap>↵</Keycap>}
    </button>
  );
}

// One line each: in a narrow panel the row leaves chips out instead (useFitStep).
const CHIP_CLASS =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-(--radius-control) px-1.5 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** Claude Code's permission modes; keys 1 to 5 pick them. */
const CLAUDE_MODES = CHAT_MODES.claude;

/**
 * A mode's hue on its chip and in its menu, Claude Code's and Codex's
 * alike; the asking modes stay plain and the dangerous one is red.
 */
const MODE_TINT: Record<string, string> = {
  auto: "text-[var(--state-success-fg)] hover:text-[var(--state-success-fg)]",
  acceptEdits: "text-[var(--syntax-function)] hover:text-[var(--syntax-function)]",
  plan: "text-[var(--state-info-fg)] hover:text-[var(--state-info-fg)]",
};

/** Tabs whose user has seen bypass mode's warning in this window. */
const bypassConfirmed = new Set<string>();

function ModeChip({ controller, state, truncate }: ChipProps & { truncate: boolean }) {
  const { t } = useTranslation();
  const set = controller.modes ?? CLAUDE_MODES;
  const bypass = set.dangerous;
  const all = set.modes;
  const safe = all.filter((m) => m !== bypass);
  const label = (key: string) => t(`${set.prefix}.${key}`);
  const mode = state.model.permissionMode ?? set.fallback;
  const name = t(`${set.prefix}.${mode}`, { defaultValue: mode });
  const ready = state.model.process === "running";
  const blocked = state.model.bypassBlocked !== undefined;
  const [open, setOpen] = useState(false);
  const pick = async (next: string) => {
    if (next === mode || (next === bypass && blocked)) return;
    if (next === bypass && !bypassConfirmed.has(controller.key)) {
      const ok = await showConfirmDialog({
        title: label("bypass_confirm_title"),
        description: label("bypass_confirm_body"),
        confirmLabel: label("bypass_confirm"),
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
      const next = all[Number(e.key) - 1];
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
          className={cn(
            CHIP_CLASS,
            MODE_TINT[mode],
            mode === bypass && "text-destructive hover:text-destructive",
            truncate && "min-w-0 shrink",
          )}
          disabled={!ready}
          title={`${t("chat.mode.aria")} · ${name}`}
          aria-label={t("chat.mode.aria")}
        >
          <span className="min-w-0 truncate">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLabel>{t("chat.mode.label")}</DropdownMenuLabel>
        {safe.map((m, i) => (
          <DropdownMenuItem key={m} onSelect={() => void pick(m)}>
            <span className="flex flex-col">
              <span className={cn(m === mode && "font-medium", MODE_TINT[m])}>{label(m)}</span>
              <span className="text-app-micro text-muted-foreground">{label(`${m}_hint`)}</span>
            </span>
            <DropdownMenuShortcut>{i + 1}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={blocked} onSelect={() => void pick(bypass)}>
          <span className="flex flex-col" title={state.model.bypassBlocked}>
            <span className={cn("text-destructive", mode === bypass && "font-medium")}>
              {label(bypass)}
            </span>
            <span className="text-app-micro text-muted-foreground">
              {blocked ? t("chat.mode.bypass_blocked") : label(`${bypass}_hint`)}
            </span>
          </span>
          <DropdownMenuShortcut>{all.length}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * The composer's keys as this platform names them: the Mac's symbols there,
 * the keys' names elsewhere, as Windows and Linux label shortcuts.
 */
export function composerKeys(): {
  send: string;
  newLine: string;
  queueKey: string;
  nowKey: string;
} {
  return isMac()
    ? { send: "↩", newLine: "⇧↩", queueKey: "⌘↩", nowKey: "⌘⇧↩" }
    : { send: "Enter", newLine: "Shift+Enter", queueKey: "Ctrl+Enter", nowKey: "Ctrl+Shift+Enter" };
}

/**
 * The composer's keys as its send button's tooltip tells them, between
 * turns or during one, for a Claude tab or a Codex tab.
 */
export function composerHint(t: TFunction, running: boolean, program: ChatAgent): string {
  return t(running ? "chat.composer.hint_running" : "chat.composer.hint", {
    ...composerKeys(),
    ...(program === "claude" ? {} : { context: program }),
  });
}

/** A model's name without its note: "Default (recommended)" is "Default". */
export function shortModelName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "") || name;
}

function ModelChip({
  controller,
  state,
  short,
  onMenu,
}: ChipProps & { short: boolean; onMenu: (open: boolean) => void }) {
  const { t } = useTranslation();
  const models = state.model.init?.models ?? [];
  const current = currentModelInfo(models, state.model.model);
  const label = current?.displayName ?? state.model.model ?? t("chat.model.default");
  const ready = state.model.process === "running" && models.length > 0;
  const [open, setOpen] = useRevealedMenu(
    controller,
    state,
    "model",
    ready ? null : t("chat.reveal.not_ready"),
    onMenu,
  );
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <button
          type="button"
          className={CHIP_CLASS}
          disabled={!ready}
          title={`${t("chat.model.aria")} · ${label}`}
          aria-label={t("chat.model.aria")}
        >
          {short ? shortModelName(label) : label}
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

function EffortChip({
  controller,
  state,
  onMenu,
}: ChipProps & { onMenu: (open: boolean) => void }) {
  const { t } = useTranslation();
  const models = state.model.init?.models ?? [];
  const levels = currentModelInfo(models, state.model.model)?.supportedEffortLevels ?? [];
  const supported = controller.supports("apply_flag_settings");
  const note = t("chat.panel.needs_version", { version: firstVersionOf("apply_flag_settings") });
  const [open, setOpen] = useRevealedMenu(
    controller,
    state,
    "effort",
    levels.length === 0
      ? t("chat.effort.none")
      : !supported
        ? note
        : state.model.process !== "running"
          ? t("chat.reveal.not_ready")
          : null,
    onMenu,
  );
  if (levels.length === 0) return null;
  const effort = state.model.effort;
  if (!supported) {
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
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
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
