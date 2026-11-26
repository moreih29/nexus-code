import type { TFunction } from "i18next";
import {
  AtSign,
  FileText,
  NotebookPen,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Slash,
  Square,
  X,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import {
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RelayedMessage } from "../../../shared/chat/relay";
import { CHAT_MODES, type ModeSet } from "../../../shared/sessions/chat-modes";
import { formatBytes } from "../../../shared/util/format-bytes";
import { useFitStep } from "../../hooks/use-fit-step";
import { appCommandsBeside, listedCommands } from "../../services/chat/app-commands";
import { firstVersionOf } from "../../services/chat/claude/versions";
import {
  applyCompletion,
  completionAt,
  fileMention,
  followTyped,
  isCommandMessage,
  isFolder,
  matchCommands,
  type TypedToken,
} from "../../services/chat/composer-input";
import { canRestoreFailedDraft, composerSendDecision } from "../../services/chat/composer-submit";
import { watchFileDrop } from "../../services/chat/file-drop";
import { fileKind } from "../../services/chat/links";
import {
  type CommandInfo,
  type ImageBlock,
  isWaiting,
  type ModelInfo,
  type UserItem,
} from "../../services/chat/model";
import { modelPickerOf } from "../../services/chat/model-picker";
import { withRelayed } from "../../services/chat/relayed";
import { type ChatTabState, type RevealPart, takeReveal } from "../../services/chat/store";
import type { QueuedMessage } from "../../services/chat/transport/queue";
import { chatNoteTarget, sendWithNoteMentions } from "../../services/notes/chat-link";
import { useChatNotes, useRecentChatNotes } from "../../services/notes/chat-notes";
import { type NoteChoice, noteChoices } from "../../services/notes/choices";
import { useChatFontStyle } from "../../state/stores/chat-font";
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
import { useChatLinks } from "./chat-links";
import { type CompletionItem, CompletionMenu } from "./completion-menu";
import { COMPOSER_CHIP_CLASS } from "./composer-chip";
import { fitTextHeight, observeTextHeight } from "./composer-height";
import { DictationOverlay, MicButton, useComposerDictation } from "./dictation";
import { surfaceChatSendError } from "./send-error";
import type { InstructionsChipSlot } from "./session-instructions-chip";

export interface ComposerController {
  readonly key: string;
  readonly claudeProfileDefaultModel?: string;
  readonly modes?: ModeSet;
  send(text: string, images?: ImageBlock[]): Promise<void>;
  sendNow?(text: string, images?: ImageBlock[]): Promise<void>;
  submitLocal?(text: string, images: ImageBlock[], now: boolean): Promise<void>;
  readHeldNow?(): Promise<void>;
  enqueue(text: string, images?: ImageBlock[]): void;
  removeQueued(id: string): QueuedMessage | undefined;
  takeBackQueued?(id: string): Promise<QueuedMessage | undefined>;
  withdraw?(sentUuid: string): Promise<boolean>;
  interrupt(): Promise<unknown>;
  clearDraft(): void;
  attach(name: string, data: string): Promise<string>;
  upload?(file: File): Promise<string>;
  sendUploaded?(
    how: "send" | "now" | "queue",
    text: string,
    images: ImageBlock[],
    uploads: readonly string[],
  ): Promise<void>;
  submitPeer?(
    how: "send" | "now" | "queue",
    text: string,
    images: ImageBlock[],
    files: readonly ComposerAttachment[],
  ): boolean;
  readonly maxAttachments?: number;
  fileSuggestions(query: string): Promise<string[]>;
  supports(subtype: string): boolean;
  setPermissionMode(mode: string): Promise<unknown>;
  setModel(model: string): Promise<unknown>;
  setEffort(level: string): Promise<unknown>;
  revealed?(seq: number): void;
}

interface ComposerProps {
  controller: ComposerController;
  state: ChatTabState;
  fallbackModels?: readonly ModelInfo[];
  instructions?: (slot: InstructionsChipSlot) => ReactNode;
  relayed?: readonly RelayedMessage[];
  local: boolean;
  placeholder?: string;
  above?: React.ReactNode;
  below?: React.ReactNode;
  onCommand?: (text: string) => boolean;
  appCommands?: boolean;
  commands?: readonly CommandInfo[];
  takesDraft?: boolean;
  peerWaitUntil?: number;
  composition?: ComposerContents & {
    setFiles: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>;
    setText: React.Dispatch<React.SetStateAction<string>>;
    setImages: React.Dispatch<React.SetStateAction<ImageBlock[]>>;
    current(): ComposerContents;
    clearSubmitted(draft: ComposerContents): void;
  };
}

type ChipProps = Pick<ComposerProps, "controller" | "state">;

export interface ComposerAttachment {
  id: number;
  file: File;
  path?: string;
}

export interface ComposerContents {
  text: string;
  images: ImageBlock[];
  files: ComposerAttachment[];
}

interface LocalDraft extends ComposerContents {
  notes: NoteChoice[];
}

const EMPTY_DRAFT: LocalDraft = { text: "", images: [], files: [], notes: [] };

function useLocalDraft() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const current = useRef(draft);
  const update = useCallback((next: LocalDraft) => {
    current.current = next;
    setDraft(next);
  }, []);
  const setters = useMemo(() => {
    const setter =
      <K extends keyof LocalDraft>(field: K): Dispatch<SetStateAction<LocalDraft[K]>> =>
      (action) => {
        const before = current.current;
        const value = typeof action === "function" ? action(before[field]) : action;
        if (value !== before[field]) update({ ...before, [field]: value });
      };
    return {
      setText: setter("text"),
      setImages: setter("images"),
      setFiles: setter("files"),
      setNotes: setter("notes"),
    };
  }, [update]);
  return { ...draft, ...setters, current, update };
}

const MAX_IMAGE_BYTES = 3_750_000;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const SUGGEST_DELAY_MS = 100;
const SUGGEST_RETRY_MS = 500;

let nextAttachmentId = 1;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const Composer = memo(function Composer({
  controller,
  state,
  fallbackModels,
  instructions,
  relayed,
  local,
  placeholder,
  above,
  below,
  onCommand,
  appCommands = true,
  commands: ownCommands,
  takesDraft = true,
  peerWaitUntil,
  composition,
}: ComposerProps) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const program = useContext(ChatAgentContext);
  const localDraft = useLocalDraft();
  const { text, images, setText, setImages } = composition ?? localDraft;
  const files = composition?.files ?? localDraft.files;
  const setFiles = composition?.setFiles ?? localDraft.setFiles;
  const chatNotes = useChatNotes();
  const setNoteChips = localDraft.setNotes;
  const notes = chatNotes ? localDraft.notes : EMPTY_DRAFT.notes;
  const [failedDrafts, setFailedDrafts] = useState<{ draft: LocalDraft; id: string }[]>([]);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const latestPeerWait = useRef(peerWaitUntil);
  const waitForPeer = useRef<((shown: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    latestPeerWait.current = peerWaitUntil;
    if (peerWaitUntil === undefined) waitForPeer.current?.(true);
  }, [peerWaitUntil]);
  useLayoutEffect(
    () => () => {
      waitForPeer.current?.(false);
    },
    [],
  );
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { model, phase } = state;
  const picker = modelPickerOf(program, model, {
    profileDefault: controller.claudeProfileDefaultModel,
    fallbackModels,
    defaultLabel: t("settings:profiles.connection.default"),
  });
  const running = model.running;
  const blocked = phase === "not-found" || phase === "held" || phase === "starting";
  const dictation = useComposerDictation({ text, setText, areaRef, disabled: blocked });
  const hasText = text.trim() !== "" || images.length > 0 || files.length > 0 || notes.length > 0;
  const canSend =
    !blocked &&
    hasText &&
    !sending &&
    (dictation.phase === "idle" || dictation.phase === "listening");
  const listening = dictation.phase === "starting" || dictation.phase === "listening";
  const hint = placeholder ?? composerHint(t, running, program);
  const held = running && model.items.some(isWaiting);
  const waiting = useMemo(
    () => withRelayed(model.items.filter(isWaiting), relayed).filter(isWaiting),
    [model.items, relayed],
  );
  const canWithdraw = !!controller.withdraw && controller.supports("cancel_async_message");
  const lastTakeBack = state.queue.findLast(
    (item) => item.status !== "sending" && item.status !== "unconfirmed",
  );
  const canTakeBack = lastTakeBack !== undefined || (canWithdraw && waiting.length > 0);
  const withdrawing = useRef(new Set<string>());

  const footerRef = useRef<HTMLDivElement>(null);
  type FooterMenu = RevealPart | "instructions";
  const [menuOf, setMenuOf] = useState<FooterMenu | null>(null);
  const kept = (part: FooterMenu) => state.reveal?.part === part || menuOf === part;
  const onMenu = (part: FooterMenu) => (open: boolean) =>
    setMenuOf((now) => (open ? part : now === part ? null : now));
  const fit = useFitStep(
    footerRef,
    `${model.permissionMode}|${picker.label}|${model.effort}|${picker.models.length}|${model.process}|${running}|${hasText}|${menuOf}|${state.reveal?.part}|${dictation.phase}|${!!instructions}`,
    FIT.WRAP,
  );

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
  const edit = (next: string, at: number, typed: TypedToken | null = null) => {
    typedRef.current = typed;
    setText(next);
    pendingCaret.current = at;
    areaRef.current?.focus();
  };

  const typedRef = useRef<TypedToken | null>(null);
  const completion = completionAt(text, caret, typedRef.current?.start ?? null);
  const completionKey = completion ? `${completion.kind}:${completion.start}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (completionKey === null) setDismissed(null);
  }, [completionKey]);
  const menuOpen = focused && completion !== null && completionKey !== dismissed;
  const cliCommands = model.init?.commands ?? model.slashCommands;
  const commands = useMemo(() => {
    if (!menuOpen || completion?.kind !== "command") return [];
    if (ownCommands) return matchCommands([...ownCommands], completion.query);
    const cli = cliCommands ?? [];
    const own = appCommands
      ? appCommandsBeside(cli, (name) => t(`chat.commands.describe.${name}`))
      : [];
    return matchCommands([...listedCommands(cli), ...own], completion.query);
  }, [menuOpen, completion?.kind, completion?.query, cliCommands, t, appCommands, ownCommands]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const listing = !ownCommands && !cliCommands;
  const noneMatch = menuOpen && completion?.kind === "command" && commands.length === 0 && !listing;
  const fileQuery = menuOpen && completion?.kind === "file" ? completion.query : null;
  const recent = useRecentChatNotes(fileQuery !== null);
  const untitled = t("notes:panel.untitled");
  const matchingNotes =
    chatNotes && fileQuery !== null
      ? noteChoices(chatNotes.notes ?? [], recent ?? [], fileQuery, untitled)
      : [];
  const [filesFor, setFilesFor] = useState<string | null>(null);
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
          setFilesFor(fileQuery);
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
        ? [
            ...matchingNotes.map((note) => ({
              key: `note:${note.noteId}`,
              label: note.title || untitled,
              hint: note.linked ? t("notes:connections.linkedNote") : undefined,
              icon: "note" as const,
              note,
            })),
            ...(filesFor === fileQuery ? suggested : []).map((path) => ({
              key: path,
              label: path,
              icon: isFolder(path) ? ("folder" as const) : ("file" as const),
            })),
          ]
        : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const active = Math.min(activeIndex, Math.max(0, items.length - 1));
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new token or query starts at the top
  useEffect(() => setActiveIndex(0), [completionKey, completion?.query]);
  const pick = (index: number) => {
    if (!completion) return;
    const item = items[index];
    if (!item) return;
    if (item.note) {
      const note = item.note;
      setNoteChips((prev) =>
        prev.some(({ noteId }) => noteId === note.noteId) ? prev : [...prev, note],
      );
      edit(text.slice(0, completion.start) + text.slice(completion.end), completion.start);
      return;
    }
    const next = applyCompletion(
      text,
      completion,
      completion.kind === "command"
        ? { kind: "command", name: item.key }
        : { kind: "file", path: item.key },
    );
    edit(next.text, next.caret, next.open);
  };

  const insertTrigger = (trigger: "/" | "@") => {
    if (trigger === "/") {
      edit(text.startsWith("/") ? text : `/${text}`, 1);
      return;
    }
    const at = Math.min(caret, text.length);
    const space = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
    const token = { start: at + space.length, caret: at + space.length + 1 };
    edit(`${text.slice(0, at)}${space}@${text.slice(at)}`, token.caret, token);
  };

  const font = useChatFontStyle();
  // biome-ignore lint/correctness/useExhaustiveDependencies: fits again as the text, placeholder or font changes
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area) fitTextHeight(area, rootRef.current?.parentElement);
  }, [text, hint, font]);
  useEffect(() => {
    const area = areaRef.current;
    if (area) return observeTextHeight(area, rootRef.current?.parentElement);
  }, []);

  const clear = (draft: ComposerContents) => {
    if (composition) composition.clearSubmitted(draft);
    else localDraft.update(EMPTY_DRAFT);
  };

  const withAttachments = async (
    body: string,
    files: ComposerAttachment[],
  ): Promise<{ message: string; uploads: string[] }> => {
    if (files.length === 0) return { message: body, uploads: [] };
    const upload = controller.upload?.bind(controller);
    if (upload) {
      return { message: body, uploads: await Promise.all(files.map((a) => upload(a.file))) };
    }
    const paths = await Promise.all(
      files.map(
        async (attachment) =>
          attachment.path ??
          controller.attach(attachment.file.name, await base64Of(attachment.file)),
      ),
    );
    const mentions = paths.map(fileMention).join(" ");
    return { message: body.trim() ? `${body}\n\n${mentions}` : mentions, uploads: [] };
  };

  const submit = async (how: "send" | "queue" | "now", dictated?: string) => {
    if (dictation.active) {
      if (canSend) dictation.finish((heard) => void submitRef.current(how, heard));
      return;
    }
    const pressed = composition?.current() ?? localDraft.current.current;
    const { images, files } = pressed;
    const body = dictated ?? pressed.text;
    const notes = chatNotes ? localDraft.current.current.notes : EMPTY_DRAFT.notes;
    const hasBody = body.trim() !== "" || images.length > 0 || files.length > 0 || notes.length > 0;
    if (blocked || submitting.current || !hasBody) return;
    const until = latestPeerWait.current;
    if (composition && until !== undefined) {
      if (Date.now() >= until) return;
      submitting.current = true;
      setSending(true);
      const shown = await new Promise<boolean>((resolve) => {
        waitForPeer.current = resolve;
      });
      waitForPeer.current = null;
      submitting.current = false;
      setSending(false);
      if (
        composerSendDecision(
          shown && latestPeerWait.current === undefined && Date.now() < until,
          shown && Date.now() < until,
          composition.current() === pressed,
        ) === "send"
      ) {
        void submitRef.current(how, dictated);
      }
      return;
    }
    if (images.length === 0 && files.length === 0 && notes.length === 0 && onCommand?.(body)) {
      clear(pressed);
      return;
    }
    const max = controller.maxAttachments;
    if (max !== undefined && images.length + files.length > max) {
      showToast({ kind: "warning", message: t("chat.composer.too_many_attachments", { max }) });
      return;
    }
    const as = how === "queue" && running ? "queue" : how === "now" && running ? "now" : "send";
    if (controller.submitPeer) {
      if (controller.submitPeer(as, body, images, files)) clear(pressed);
      return;
    }
    const submitted = { text: body, images, files, notes };
    submitting.current = true;
    setSending(true);
    clear(pressed);
    try {
      const target = chatNotes && notes.length ? chatNoteTarget(chatNotes.chat) : undefined;
      const linked = await sendWithNoteMentions(body, notes, target, async (textWithNotes) => {
        const { message, uploads } = await withAttachments(textWithNotes, files);
        if (uploads.length > 0 && controller.sendUploaded) {
          await controller.sendUploaded(as, message, images, uploads);
        } else if (as === "queue") {
          controller.enqueue(message, images);
        } else if (controller.submitLocal) {
          await controller.submitLocal(message, images, as === "now");
        } else if (as === "now" && controller.sendNow) {
          await controller.sendNow(message, images);
        } else {
          await controller.send(message, images);
        }
      });
      if (!linked) showToast({ kind: "error", message: t("notes:conversations.saveError") });
    } catch (error) {
      if (canRestoreFailedDraft(localDraft.current.current, "failed")) {
        localDraft.update(submitted);
      } else {
        const id = crypto.randomUUID();
        setFailedDrafts((previous) => [...previous, { draft: submitted, id }]);
      }
      surfaceChatSendError(error);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const addFiles = useCallback(
    async (picked: Iterable<File>) => {
      const added: ImageBlock[] = [];
      const attached: ComposerAttachment[] = [];
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
    [t, local, setImages, setFiles],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (dictation.active) {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        dictation.toggle();
      }
      return;
    }
    if (e.currentTarget.dataset.cardKeys !== undefined) return;
    if (noneMatch && e.key === "Escape") {
      e.preventDefault();
      setDismissed(completionKey);
      return;
    }
    if (menuOpen && items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((active + step + items.length) % items.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        if (
          program === "codex" &&
          images.length === 0 &&
          files.length === 0 &&
          notes.length === 0 &&
          e.key === "Enter" &&
          completion?.kind === "command" &&
          text.trim().toLowerCase() === `/${items[active]?.key}` &&
          !items[active]?.hint
        ) {
          void submit("send");
        } else pick(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(completionKey);
        return;
      }
    }
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) void submit("queue");
      else if (canSend) void submit("now");
      else if (held) void controller.readHeldNow?.().catch((err: Error) => showError(err));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit("send");
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

  const [dropArea, setDropArea] = useState<HTMLElement | null>(null);
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    setDropArea(rootRef.current?.closest<HTMLElement>("[data-chat-drop]") ?? rootRef.current);
  }, []);
  useEffect(() => {
    if (!dropArea) return;
    return watchFileDrop(dropArea, {
      over: setDropping,
      drop: (dropped) => {
        void addFiles(dropped);
        areaRef.current?.focus();
      },
    });
  }, [dropArea, addFiles]);

  const draft = takesDraft ? state.draft : undefined;
  const tookDraft = useRef(0);
  useEffect(() => {
    if (!draft || draft.nonce === tookDraft.current) return;
    tookDraft.current = draft.nonce;
    setText((prev) => (prev ? `${prev}\n${draft.text}` : draft.text));
    setImages((prev) => [...prev, ...draft.images]);
    areaRef.current?.focus();
    controller.clearDraft();
  }, [draft, controller, setText, setImages]);

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

  const takeBackQueued = async (id: string, before: boolean) => {
    try {
      const item = controller.takeBackQueued
        ? await controller.takeBackQueued(id)
        : controller.removeQueued(id);
      if (item) putBack(item, before);
    } catch (err) {
      showError(err as Error);
    }
  };

  const takeBackLast = () => {
    if (lastTakeBack) {
      void takeBackQueued(lastTakeBack.id, true);
      return;
    }
    const sent = waiting.filter((item) => !withdrawing.current.has(item.sentUuid ?? ""));
    const lastSent = sent[sent.length - 1];
    if (lastSent && canWithdraw) void takeBackWaiting(lastSent, "before");
  };

  const pullBack = (id: string) => void takeBackQueued(id, false);
  const removeFailedDraft = (id: string) =>
    setFailedDrafts((previous) => previous.filter((entry) => entry.id !== id));
  const restoreFailedDraft = (draft: LocalDraft, id: string) => {
    const current = localDraft.current.current;
    localDraft.update({
      text: [current.text, draft.text].filter(Boolean).join("\n"),
      images: [...current.images, ...draft.images],
      files: [...current.files, ...draft.files],
      notes: [
        ...new Map([...current.notes, ...draft.notes].map((note) => [note.noteId, note])).values(),
      ],
    });
    removeFailedDraft(id);
    areaRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="@container/composer shrink-0 border-t border-border pt-2 pb-3"
      data-testid="chat-composer"
      data-toast-avoid
    >
      {dropping && dropArea && createPortal(<DropCue />, dropArea)}
      <div className="mx-auto flex w-[calc(100%-2rem)] max-w-[860px] flex-col gap-2 @max-[120px]/composer:w-[calc(100%-0.5rem)]">
        {above}
        {(waiting.length > 0 || state.queue.length > 0 || failedDrafts.length > 0) && (
          <ul className="flex flex-col gap-1" aria-label={t("chat.queue.aria")}>
            {failedDrafts.map(({ draft, id }) => (
              <QueueRow
                key={id}
                label={t("chat.queue.failed")}
                item={{
                  ...draft,
                  text:
                    draft.text ||
                    [
                      ...draft.files.map(({ file }) => file.name),
                      ...draft.notes.map(({ title }) => title),
                    ].join(", "),
                }}
                onEdit={() => restoreFailedDraft(draft, id)}
                onRemove={() => removeFailedDraft(id)}
              />
            ))}
            {waiting.map((item) => (
              <QueueRow
                key={item.key}
                label={
                  isCommandMessage(item.text, item.images.length, cliCommands)
                    ? t("chat.queue.after_turn")
                    : t("chat.queue.label")
                }
                item={item}
                onEdit={canWithdraw ? () => void takeBackWaiting(item, "after") : undefined}
                onRemove={canWithdraw ? () => void takeBackWaiting(item, "nowhere") : undefined}
              />
            ))}
            {state.queue.map((item) => (
              <QueueRow
                key={item.id}
                label={
                  item.status
                    ? t(`chat.queue.${item.status}`)
                    : item.afterTool !== undefined
                      ? t("chat.queue.after_tool")
                      : program === "codex" && controller.submitPeer
                        ? t("chat.queue.label")
                        : t("chat.queue.after_turn")
                }
                item={item}
                onEdit={item.status !== "sending" ? () => pullBack(item.id) : undefined}
                onRemove={
                  item.status !== "sending" ? () => controller.removeQueued(item.id) : undefined
                }
              />
            ))}
            {canTakeBack && (
              <li className="px-2 text-app-micro text-muted-foreground">
                {t("chat.queue.take_back")}
              </li>
            )}
          </ul>
        )}
        <div
          className={cn(
            "relative rounded-(--radius-raised) border border-border bg-background focus-within:border-ring",
            dropping && "border-ring",
          )}
        >
          {menuOpen && completion && (
            <CompletionMenu
              kind={completion.kind}
              items={items}
              listing={listing}
              active={active}
              onPick={pick}
              onHover={setActiveIndex}
            />
          )}
          {(images.length > 0 || files.length > 0 || notes.length > 0) && (
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
              {notes.map(({ noteId, title }) => (
                <div
                  key={noteId}
                  className="flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border pl-2 pr-1 text-app-ui-sm"
                  title={title || untitled}
                  data-testid="chat-note-mention"
                >
                  <NotebookPen
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{title || untitled}</span>
                  <IconButton
                    label={t("notes:connections.removeMention")}
                    size="xs"
                    onClick={() =>
                      setNoteChips((prev) => prev.filter((note) => note.noteId !== noteId))
                    }
                  >
                    <X className="size-3" />
                  </IconButton>
                </div>
              ))}
              {files.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex h-14 max-w-56 items-center gap-1.5 rounded-(--radius-control) border border-border px-2 text-app-ui-sm"
                  title={attachment.path ?? attachment.file.name}
                  data-testid="chat-attachment"
                >
                  <AttachmentLabel file={attachment.file} />
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
          <div className="relative">
            <textarea
              ref={areaRef}
              value={text}
              onChange={(e) => {
                const at = e.target.selectionStart;
                typedRef.current = followTyped(text, e.target.value, at, typedRef.current);
                setText(e.target.value);
                setCaret(at);
              }}
              onSelect={(e) => {
                const at = e.currentTarget.selectionStart;
                if (typedRef.current && typedRef.current.caret !== at) typedRef.current = null;
                setCaret(at);
              }}
              onFocus={() => {
                setFocused(true);
                dictation.onFocus();
              }}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              readOnly={dictation.active}
              rows={2}
              placeholder={listening ? t("voice.listeningPlaceholder") : hint}
              aria-label={t("chat.composer.aria", agent)}
              className={cn(
                "app-scrollbar block w-full resize-none bg-transparent px-3 py-2 text-app-body outline-none placeholder:text-muted-foreground",
                dictation.partial && "text-transparent caret-transparent",
              )}
            />
            {dictation.partial && (
              <DictationOverlay
                text={text}
                partial={dictation.partial}
                areaRef={areaRef}
                className="px-3 py-2 text-app-body"
              />
            )}
          </div>
          <div
            ref={footerRef}
            className={cn(
              "flex items-center gap-1 overflow-hidden px-1.5 pb-1.5 @max-[64px]/composer:px-0.5",
              fit >= FIT.WRAP && "flex-wrap justify-end",
            )}
          >
            {fit < FIT.NO_MODE && (
              <ModeChip controller={controller} state={state} truncate={fit >= FIT.TRUNCATE_MODE} />
            )}
            {(fit < FIT.NO_MODEL || kept("model")) && (
              <ModelChip
                controller={controller}
                state={state}
                picker={picker}
                short={fit >= FIT.SHORT_MODEL}
                onMenu={onMenu("model")}
              />
            )}
            {(fit < FIT.NO_EFFORT || kept("effort")) && (
              <EffortChip
                controller={controller}
                state={state}
                levels={picker.current?.supportedEffortLevels ?? []}
                onMenu={onMenu("effort")}
              />
            )}
            {instructions &&
              (fit < FIT.NO_INSTRUCTIONS || kept("instructions")) &&
              instructions({
                compact: fit >= FIT.TRUNCATE_MODE,
                onMenu: onMenu("instructions"),
              })}
            {fit < FIT.WRAP && <div className="flex-1" />}
            {fit < FIT.NO_ADD && (
              <AddMenu
                onAttach={() => fileRef.current?.click()}
                onMention={
                  controller.supports("file_suggestions")
                    ? () => insertTrigger("@")
                    : t("chat.panel.needs_version", { version: firstVersionOf("file_suggestions") })
                }
                onCommand={
                  (ownCommands?.length ?? cliCommands?.length ?? 0) > 0
                    ? () => insertTrigger("/")
                    : undefined
                }
                returnFocus={() => areaRef.current?.focus()}
              />
            )}
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
            {(fit < FIT.NO_MIC || dictation.phase !== "idle") && (
              <MicButton dictation={dictation} compact={fit >= FIT.NO_MODEL} />
            )}
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
});

function showError(err: Error): void {
  showToast({ kind: "error", message: err.message });
}

const FIT = {
  SHORT_MODEL: 1,
  NO_KEYCAP: 2,
  NO_EFFORT: 3,
  NO_MODEL: 4,
  TRUNCATE_MODE: 5,
  NO_MODE: 6,
  NO_INSTRUCTIONS: 7,
  NO_MIC: 8,
  NO_ADD: 9,
  WRAP: 10,
} as const;

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
    if (controller.revealed) controller.revealed(reveal);
    else takeReveal(controller.key, reveal);
    if (unavailable) showToast({ kind: "info", message: unavailable });
    else setOpen(true);
  }, [reveal]);
  return [open, setOpen];
}

function AttachmentLabel({ file }: { file: File }) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const body = (
    <>
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate">{file.name}</div>
        <div className="text-app-micro text-muted-foreground">{formatBytes(file.size)}</div>
      </div>
    </>
  );
  if (!links || fileKind(file.name) !== "image") return body;
  const look = () =>
    void base64Of(file).then((data) =>
      links.openImages([{ mediaType: file.type || "image/png", data }], 0),
    );
  return (
    <button
      type="button"
      onClick={look}
      aria-label={`${t("chat.links.look")}: ${file.name}`}
      className="flex min-w-0 flex-1 cursor-zoom-in items-center gap-1.5 rounded-(--radius-control) text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid="chat-attachment-look"
    >
      {body}
    </button>
  );
}

function AddMenu({
  onAttach,
  onMention,
  onCommand,
  returnFocus,
}: {
  onAttach: () => void;
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
          if (typed.current) {
            event.preventDefault();
            typed.current = false;
            returnFocus();
          }
        }}
      >
        <DropdownMenuItem onSelect={onAttach}>
          <span className="flex items-center gap-2">
            <Paperclip className="size-3.5" />
            {t("chat.composer.attach_file")}
          </span>
        </DropdownMenuItem>
        {typeof onMention === "string" ? (
          <DropdownMenuItem disabled onSelect={() => {}}>
            <span className="flex items-center gap-2">
              <AtSign className="size-3.5" />
              <span className="flex flex-col">
                {t("chat.composer.mention_file")}
                <span className="text-app-micro text-muted-foreground">{onMention}</span>
              </span>
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              typed.current = true;
              onMention();
            }}
          >
            <span className="flex items-center gap-2">
              <AtSign className="size-3.5" />
              {t("chat.composer.mention_file")}
            </span>
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
            <span className="flex items-center gap-2">
              <Slash className="size-3.5" />
              {t("chat.composer.command")}
            </span>
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

function DropCue() {
  const { t } = useTranslation();
  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 flex bg-background/70 p-2"
      data-testid="chat-drop-cue"
      aria-hidden
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-(--radius-raised) border-2 border-primary/60 border-dashed bg-primary/10">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Paperclip className="size-5" />
        </span>
        <span className="font-medium text-app-body text-foreground">
          {t("chat.composer.drop_title")}
        </span>
        <span className="text-app-ui-sm text-muted-foreground">{t("chat.composer.drop_hint")}</span>
      </div>
    </div>
  );
}

function QueueRow({
  label,
  item,
  onEdit,
  onRemove,
}: {
  label: string;
  item: { text: string; images: readonly ImageBlock[]; error?: string };
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 rounded-(--radius-control) bg-muted px-2 py-1 text-app-ui-sm">
      <span className="shrink-0 text-app-micro text-muted-foreground" title={item.error}>
        {label}
      </span>
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

export const SEND_BUTTON_CLASS =
  "flex shrink-0 items-center gap-1 rounded-(--radius-control) bg-primary py-1.5 text-primary-foreground hover:opacity-90 disabled:pointer-events-none disabled:opacity-40";

function SendButton({
  running,
  waits,
  program,
  onClick,
  disabled,
  keycap,
}: {
  running: boolean;
  waits: boolean;
  program: ChatAgent;
  onClick: () => void;
  disabled: boolean;
  keycap: boolean;
}) {
  const { t } = useTranslation();
  const queues = running && waits;
  const label = queues
    ? t("chat.composer.queue")
    : running
      ? t("chat.composer.steer")
      : t("chat.composer.send");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={composerHint(t, running, program)}
      aria-label={label}
      className={cn(SEND_BUTTON_CLASS, keycap ? "pr-1.5 pl-2" : "px-2")}
      data-testid="chat-send"
    >
      <Send className="size-4" />
      {keycap && <Keycap>↵</Keycap>}
    </button>
  );
}

const CLAUDE_MODES = CHAT_MODES.claude;

const MODE_TINT: Record<string, string> = {
  auto: "text-[var(--state-success-fg)] hover:text-[var(--state-success-fg)]",
  acceptEdits: "text-[var(--syntax-function)] hover:text-[var(--syntax-function)]",
  plan: "text-[var(--state-info-fg)] hover:text-[var(--state-info-fg)]",
};

const bypassConfirmed = new Set<string>();

export function ModeChip({
  controller,
  state,
  truncate = false,
  side = "top",
}: ChipProps & { truncate?: boolean; side?: "top" | "bottom" }) {
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
  }, [open, all]);
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <button
          type="button"
          className={cn(
            COMPOSER_CHIP_CLASS,
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
      <DropdownMenuContent side={side}>
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

export function composerKeys(): {
  send: string;
  newLine: string;
  queueKey: string;
  nowKey: string;
} {
  return isMac()
    ? { send: "↩", newLine: "⇧↩", queueKey: "⌘⇧↩", nowKey: "⌘↩" }
    : { send: "Enter", newLine: "Shift+Enter", queueKey: "Ctrl+Shift+Enter", nowKey: "Ctrl+Enter" };
}

export function composerHint(t: TFunction, running: boolean, program: ChatAgent): string {
  return t(running ? "chat.composer.hint_running" : "chat.composer.hint", {
    ...composerKeys(),
    ...(program === "claude" ? {} : { context: program }),
  });
}

export function shortModelName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "") || name;
}

function ModelChip({
  controller,
  state,
  picker,
  short,
  onMenu,
}: ChipProps & {
  picker: ReturnType<typeof modelPickerOf>;
  short: boolean;
  onMenu: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { current, options } = picker;
  const label = picker.label ?? t("chat.model.default");
  const ready = state.model.process === "running" && picker.models.length > 0;
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
          className={COMPOSER_CHIP_CLASS}
          disabled={!ready}
          title={`${t("chat.model.aria")} · ${label}`}
          aria-label={t("chat.model.aria")}
        >
          {short ? shortModelName(label) : label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        <DropdownMenuLabel>{t("chat.model.label")}</DropdownMenuLabel>
        {options.map(({ model, label, detail }) => (
          <DropdownMenuItem
            key={model.value}
            onSelect={() => controller.setModel(model.value).catch((err: Error) => showError(err))}
          >
            <span className={cn(model === current && "font-medium")}>{label}</span>
            {detail && (
              <span className="ml-4 max-w-64 truncate text-app-micro text-muted-foreground">
                {detail}
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
  levels,
  onMenu,
}: ChipProps & { levels: readonly string[]; onMenu: (open: boolean) => void }) {
  const { t } = useTranslation();
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
        className={COMPOSER_CHIP_CLASS}
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
          className={COMPOSER_CHIP_CLASS}
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
