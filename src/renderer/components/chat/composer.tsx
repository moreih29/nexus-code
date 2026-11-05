// Where the user writes to Claude: the message box, its images, the
// messages held for the turn's end, and the chips that switch the session's
// model, effort and permission mode.
//
// ↩ sends, and during a turn Claude reads it after the current tool; ⌘↩
// holds it until the turn ends; ⇧↩ breaks the line; esc stops the turn.

import { ImagePlus, Pencil, Send, Square, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatController } from "../../services/chat/controller";
import type { ImageBlock, ModelInfo } from "../../services/chat/model";
import type { ChatTabState } from "../../services/chat/store";
import { cn } from "../../utils/cn";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";

interface ComposerProps {
  controller: ChatController;
  state: ChatTabState;
}

/** The API's limit on one image, before base64. */
const MAX_IMAGE_BYTES = 3_750_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ROWS_PX = 240;

export function Composer({ controller, state }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageBlock[]>([]);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { model, phase } = state;
  const running = model.running;
  const blocked = phase === "not-found" || phase === "held" || phase === "starting";
  const canSend = !blocked && (text.trim() !== "" || images.length > 0);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_ROWS_PX)}px`;
  });

  const clear = () => {
    setText("");
    setImages([]);
  };

  const submit = (queue: boolean) => {
    if (!canSend) return;
    if (queue && running) controller.enqueue(text, images);
    else void controller.send(text, images).catch((err: Error) => showError(err));
    clear();
  };

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const added: ImageBlock[] = [];
      for (const file of files) {
        if (!IMAGE_TYPES.has(file.type)) continue;
        if (file.size > MAX_IMAGE_BYTES) {
          showToast({
            kind: "warning",
            message: t("chat.composer.image_too_large", { name: file.name }),
          });
          continue;
        }
        added.push({ mediaType: file.type, data: await base64Of(file) });
      }
      if (added.length > 0) setImages((prev) => [...prev, ...added]);
    },
    [t],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      void controller.interrupt().catch((err: Error) => showError(err));
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => IMAGE_TYPES.has(f.type));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

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
        <div className="rounded-(--radius-raised) border border-border bg-background focus-within:border-ring">
          {images.length > 0 && (
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
            </div>
          )}
          <textarea
            ref={areaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={
              running ? t("chat.composer.placeholder_running") : t("chat.composer.placeholder")
            }
            aria-label={t("chat.composer.aria")}
            className="block w-full resize-none bg-transparent px-3 py-2 text-app-body outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <ModeChip controller={controller} state={state} />
            <ModelChip controller={controller} state={state} />
            <EffortChip controller={controller} state={state} />
            <div className="flex-1" />
            <IconButton
              label={t("chat.composer.attach_image")}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" />
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
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
            <IconButton
              label={running ? t("chat.composer.send_now") : t("chat.composer.send")}
              onClick={() => submit(false)}
              disabled={!canSend}
              primary
            >
              <Send className="size-4" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function showError(err: Error): void {
  showToast({ kind: "error", message: err.message });
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

/** Permission modes in the order the chip lists them. */
const MODES = ["auto", "default", "acceptEdits", "plan"] as const;
const BYPASS = "bypassPermissions";

/** Tabs whose user has seen bypass mode's warning in this window. */
const bypassConfirmed = new Set<string>();

function ModeChip({ controller, state }: ComposerProps) {
  const { t } = useTranslation();
  const mode = state.model.permissionMode ?? "default";
  const ready = state.model.process === "running";
  const pick = async (next: string) => {
    if (next === mode) return;
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
  return (
    <DropdownMenuRoot>
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
        {MODES.map((m) => (
          <DropdownMenuItem key={m} onSelect={() => void pick(m)}>
            <span className={cn(m === mode && "font-medium")}>{t(`chat.mode.${m}`)}</span>
            <span className="ml-4 text-app-micro text-muted-foreground">
              {t(`chat.mode.${m}_hint`)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void pick(BYPASS)}>
          <span className={cn("text-destructive", mode === BYPASS && "font-medium")}>
            {t(`chat.mode.${BYPASS}`)}
          </span>
          <span className="ml-4 text-app-micro text-muted-foreground">
            {t(`chat.mode.${BYPASS}_hint`)}
          </span>
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

function ModelChip({ controller, state }: ComposerProps) {
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

function EffortChip({ controller, state }: ComposerProps) {
  const { t } = useTranslation();
  const models = state.model.init?.models ?? [];
  const levels = currentModelInfo(models, state.model.model)?.supportedEffortLevels ?? [];
  if (levels.length === 0 || !controller.supports("apply_flag_settings")) return null;
  const effort = state.model.effort;
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
          {t("chat.effort.chip", { level: effort ?? t("chat.effort.default") })}
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
