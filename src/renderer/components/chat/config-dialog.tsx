import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CONFIG_KEYS,
  type ConfigGroup,
  type ConfigKey,
  type ConfigShown,
  type ConfigValue,
  changesOf,
  choicesOf,
  configKeysOf,
  configMessages,
  configValues,
  defaultEffortLevels,
  defaultEffortOf,
  effortModelOf,
  modelChoiceOf,
} from "../../services/chat/claude/config";
import type { ChatController } from "../../services/chat/claude/controller";
import type { ModelInfo } from "../../services/chat/model";
import type { ChatTabState } from "../../services/chat/store";
import { cn } from "../../utils/cn";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../settings/section";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { showToast } from "../ui/toast";
import { ToggleChevron } from "../ui/toggle-chevron";

export interface ConfigSource {
  load(show: (shown: ConfigShown) => void, fail: (message: string) => void): () => void;
  apply(
    changes: Readonly<Record<string, ConfigValue>>,
    keys: readonly ConfigKey[],
    after: { model?: string; effort?: string },
  ): Promise<void>;
}

export function controllerConfigSource(controller: ChatController): ConfigSource {
  return {
    load(show, fail) {
      let live = true;
      let listed = controller.savedConfigKeys();
      let read: Awaited<ReturnType<ChatController["readConfig"]>> | null = null;
      const shown = () => {
        if (!live || !read) return;
        const { effective, global, model } = read;
        const keys = configKeysOf(listed);
        show({
          keys,
          values: configValues(effective, global, keys),
          effective,
          model,
          effort: controller.supports("update_settings"),
          models: controller.state.model.init?.models ?? [],
          outputStyles: controller.state.model.init?.outputStyles,
        });
      };
      controller.readConfig().then(
        (config) => {
          read = config;
          shown();
        },
        (err: Error) => live && fail(err.message),
      );
      void controller.listConfigKeys().then((keys) => {
        if (!keys || JSON.stringify(keys) === JSON.stringify(listed)) return;
        listed = keys;
        shown();
      });
      return () => {
        live = false;
      };
    },
    apply: (changes, keys, after) => controller.applyConfig(configMessages(changes, keys), after),
  };
}

type Loaded = "loading" | { failed: string } | ConfigShown;

const EFFORT = "effortDefault";

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
  focus?: string;
  onClose: () => void;
}) {
  const source = useMemo(() => controllerConfigSource(controller), [controller]);
  return (
    <ConfigDialogView
      source={source}
      running={state.model.running}
      open={open}
      focus={focus}
      onClose={onClose}
    />
  );
}

export function ConfigDialogView({
  source,
  running,
  open,
  focus,
  onClose,
}: {
  source: ConfigSource;
  running: boolean;
  open: boolean;
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
    setLoaded("loading");
    setDraft({});
    setBusy(false);
    setOtherOpen(CONFIG_KEYS.find((k) => k.key === focus)?.group === "other");
    return source.load(setLoaded, (failed) => setLoaded({ failed }));
  }, [source, open, focus]);

  const values = typeof loaded === "object" && "values" in loaded ? loaded.values : null;

  const shown = values !== null;
  useEffect(() => {
    if (!focus || !shown) return;
    const row = bodyRef.current?.querySelector(`[data-config-key="${focus}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("button[role], input")?.focus();
  }, [focus, shown]);

  const { [EFFORT]: draftEffort, ...draftKeys } = draft;
  const changes = values
    ? changesOf(Object.fromEntries(Object.entries(draftKeys).filter(([k]) => k in values)), values)
    : {};
  const ready = typeof loaded === "object" && "keys" in loaded ? loaded : null;
  const models = ready?.models ?? [];
  const outputStyles = ready?.outputStyles;
  const effortModel = ready
    ? effortModelOf(
        typeof changes.model === "string" ? changes.model : undefined,
        ready.model,
        models,
      )
    : undefined;
  const effortLevels = ready?.effort
    ? defaultEffortLevels(effortModel?.info?.supportedEffortLevels)
    : [];
  const effortNow =
    ready && effortModel ? defaultEffortOf(ready.effective, effortModel.id) : undefined;
  const effortChange =
    typeof draftEffort === "string" && draftEffort !== effortNow ? draftEffort : undefined;
  const changed = Object.keys(changes).length + (effortChange ? 1 : 0);

  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await source.apply(changes, ready.keys, {
        model: typeof changes.model === "string" ? changes.model : undefined,
        effort: effortChange,
      });
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
                        {t(otherOpen ? "chat.config.hide" : "chat.config.show")}
                        <ToggleChevron open={otherOpen} className="size-3 text-current" />
                      </button>
                    ) : undefined
                  }
                >
                  {!folded &&
                    loaded.keys
                      .filter((k) => k.group === group)
                      .map((key) => (
                        <div key={key.key}>
                          <div
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
                              outputStyles={outputStyles}
                              models={models}
                              onChange={(value) => set(key.key, value)}
                              onReset={() => reset(key.key)}
                            />
                          </div>
                          {key.key === "model" && effortLevels.length > 0 && (
                            <div data-config-key={EFFORT} className="mt-3">
                              <ConfigRow
                                configKey={{
                                  key: EFFORT,
                                  group: "conversation",
                                  kind: "choice",
                                  options: effortLevels,
                                }}
                                label={t("chat.config.key.effortDefault", {
                                  model: effortModel?.info?.displayName ?? effortModel?.id,
                                })}
                                current={effortNow}
                                value={draftEffort ?? effortNow}
                                dirty={effortChange !== undefined}
                                models={models}
                                onChange={(value) => set(EFFORT, value)}
                                onReset={() => reset(EFFORT)}
                              />
                            </div>
                          )}
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
  label: givenLabel,
  current,
  value,
  dirty,
  outputStyles,
  models,
  onChange,
  onReset,
}: {
  configKey: ConfigKey;
  label?: string;
  current: ConfigValue | undefined;
  value: ConfigValue | undefined;
  dirty: boolean;
  outputStyles?: readonly string[];
  models: readonly ModelInfo[];
  onChange: (value: ConfigValue) => void;
  onReset: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { key, kind } = configKey;
  const label = givenLabel ?? t(`chat.config.key.${key}`, { defaultValue: key });
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
              {optionLabel(t, key, choice, models)}
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
  models: readonly ModelInfo[],
): string {
  if (choice === "true") return t("chat.config.on");
  if (choice === "false") return t("chat.config.off");
  if (key === "model") {
    const { info, long } = modelChoiceOf(choice, models);
    const name = info?.displayName
      ? `${info.displayName}${long ? " · 1M" : ""}`
      : t(`chat.config.option.model.${choice}`, { defaultValue: choice });
    return choice === "default" ? t("chat.config.option.model.default") : name;
  }
  if (key === "permissionMode")
    return t(`agentConfig.claude.permissionMode.${choice}`, { defaultValue: choice });
  return t(`chat.config.option.${key}.${choice}`, { defaultValue: choice });
}
