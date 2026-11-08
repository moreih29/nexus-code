// Claude Code's own settings (/config), as a dialog: what they are now,
// read from get_settings and the global config file, and the changes sent
// back as /config messages, which Claude Code saves where its panel would.

import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CONFIG_KEYS,
  type ConfigGroup,
  type ConfigKey,
  type ConfigValue,
  changesOf,
  choicesOf,
  configMessages,
  configValues,
} from "../../services/chat/claude-config";
import type { ChatController } from "../../services/chat/controller";
import type { ChatTabState } from "../../services/chat/store";
import { cn } from "../../utils/cn";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../settings/section";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { showToast } from "../ui/toast";

type Loaded = "loading" | { failed: string } | { values: Record<string, ConfigValue | undefined> };

const GROUPS: readonly ConfigGroup[] = ["conversation", "work", "other"];

export function ConfigDialog({
  controller,
  state,
  open,
  focus,
  onClose,
}: {
  controller: ChatController;
  state: ChatTabState;
  open: boolean;
  /** The key a command opened the dialog at (/output-style, /autocompact). */
  focus?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>("loading");
  const [draft, setDraft] = useState<Record<string, ConfigValue>>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded("loading");
    setDraft({});
    setBusy(false);
    setOtherOpen(CONFIG_KEYS.find((k) => k.key === focus)?.group === "other");
    controller.readConfig().then(
      ({ effective, global }) => live && setLoaded({ values: configValues(effective, global) }),
      (err: Error) => live && setLoaded({ failed: err.message }),
    );
    return () => {
      live = false;
    };
  }, [controller, open, focus]);

  const values = typeof loaded === "object" && "values" in loaded ? loaded.values : null;

  // The key the command named, in view and with the keyboard.
  useEffect(() => {
    if (!focus || !values) return;
    const row = bodyRef.current?.querySelector(`[data-config-key="${focus}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("button[role], input")?.focus();
  }, [focus, values]);

  const changes = values ? changesOf(draft, values) : {};
  const changed = Object.keys(changes).length;
  const running = state.model.running;

  const apply = async () => {
    setBusy(true);
    try {
      await controller.sendCommands(configMessages(changes));
      onClose();
    } catch (err) {
      setBusy(false);
      showToast({
        kind: "error",
        message: t("chat.config.failed", { error: (err as Error).message }),
      });
    }
  };

  const set = (key: string, value: ConfigValue) => setDraft((d) => ({ ...d, [key]: value }));
  const reset = (key: string) =>
    setDraft((d) => {
      const { [key]: _, ...rest } = d;
      return rest;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      size="lg"
      className="flex flex-col"
      contentStyle={{ maxHeight: "min(80vh, 760px)" }}
    >
      <DialogHeader
        title={t("chat.config.title")}
        description={t("chat.config.description")}
        close
      />
      <div
        ref={bodyRef}
        className="app-scrollbar -mx-4 mt-4 min-h-0 flex-1 overflow-y-auto px-4"
        data-testid="chat-config"
      >
        {loaded === "loading" ? (
          <div className="py-8 text-center text-app-ui-sm text-muted-foreground">
            {t("chat.config.loading")}
          </div>
        ) : "failed" in loaded ? (
          <div className="py-8 text-center text-app-ui-sm text-[var(--state-error-fg)]">
            {t("chat.config.read_failed", { error: loaded.failed })}
          </div>
        ) : (
          <div className="flex flex-col gap-5 pb-1">
            {GROUPS.map((group) => {
              const folded = group === "other" && !otherOpen;
              return (
                <SettingsGroup
                  key={group}
                  title={t(`chat.config.group.${group}`)}
                  description={group === "other" ? t("chat.config.group.other_hint") : undefined}
                  action={
                    group === "other" ? (
                      <button
                        type="button"
                        aria-expanded={otherOpen}
                        onClick={() => setOtherOpen((v) => !v)}
                        className="inline-flex items-center gap-0.5 rounded-(--radius-control) px-1.5 py-0.5 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
                      >
                        <ChevronRight
                          className={cn("size-3 transition-transform", otherOpen && "rotate-90")}
                          aria-hidden="true"
                        />
                        {t(otherOpen ? "chat.config.hide" : "chat.config.show")}
                      </button>
                    ) : undefined
                  }
                >
                  {!folded &&
                    CONFIG_KEYS.filter((k) => k.group === group).map((key) => (
                      <div
                        key={key.key}
                        data-config-key={key.key}
                        className={cn(
                          focus === key.key &&
                            "-mx-2 rounded-(--radius-control) bg-[var(--state-hover-bg)] px-2 py-1",
                        )}
                      >
                        <ConfigRow
                          configKey={key}
                          current={loaded.values[key.key]}
                          value={key.key in draft ? draft[key.key] : loaded.values[key.key]}
                          dirty={key.key in changes}
                          outputStyles={state.model.init?.outputStyles}
                          onChange={(value) => set(key.key, value)}
                          onReset={() => reset(key.key)}
                        />
                      </div>
                    ))}
                </SettingsGroup>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-app-ui-sm text-muted-foreground">
          {running ? t("chat.config.running") : t("chat.config.via_command")}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => void apply()}
          disabled={busy || running || changed === 0}
          data-testid="chat-config-apply"
        >
          {changed > 0 ? t("chat.config.apply_count", { count: changed }) : t("action.apply")}
        </Button>
      </div>
    </Dialog>
  );
}

function ConfigRow({
  configKey,
  current,
  value,
  dirty,
  outputStyles,
  onChange,
  onReset,
}: {
  configKey: ConfigKey;
  current: ConfigValue | undefined;
  value: ConfigValue | undefined;
  dirty: boolean;
  outputStyles?: readonly string[];
  onChange: (value: ConfigValue) => void;
  onReset: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { key, kind } = configKey;
  const label = t(`chat.config.key.${key}`);
  // Only some have a line saying what they do.
  const descKey = `chat.config.desc.${key}`;
  const description = i18n.exists(descKey) ? t(descKey) : undefined;

  if (kind === "boolean" && current !== undefined) {
    return (
      <SettingsSwitch
        label={label}
        description={description}
        checked={value === true}
        onChange={onChange}
        dirty={dirty}
        onReset={onReset}
      />
    );
  }
  if (kind === "text") {
    return (
      <SettingsRow
        label={label}
        description={description}
        htmlFor={id}
        dirty={dirty}
        onReset={onReset}
      >
        <input
          id={id}
          type="text"
          value={typeof value === "string" ? value : ""}
          maxLength={200}
          spellCheck={false}
          placeholder={t(`chat.config.placeholder.${key}`)}
          onChange={(e) => onChange(e.target.value)}
          className="w-44 rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </SettingsRow>
    );
  }
  // A choice, or an on/off setting whose value is not known: its default
  // until one is picked.
  const choices =
    kind === "boolean" ? ["true", "false"] : choicesOf(configKey, current, outputStyles);
  return (
    <SettingsRow label={label} description={description} dirty={dirty} onReset={onReset}>
      <Select
        value={value === undefined ? "" : String(value)}
        onValueChange={(next) => onChange(kind === "boolean" ? next === "true" : next)}
      >
        <SelectTrigger ariaLabel={label} className="w-44">
          <SelectValue placeholder={t("chat.config.default")} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {optionLabel(t, key, choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

function optionLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  choice: string,
): string {
  if (choice === "true") return t("chat.config.on");
  if (choice === "false") return t("chat.config.off");
  // The permission modes, as the composer's mode chip calls them.
  const fallback =
    key === "permissionMode" ? t(`chat.mode.${choice}`, { defaultValue: choice }) : choice;
  return t(`chat.config.option.${key}.${choice}`, { defaultValue: fallback });
}
