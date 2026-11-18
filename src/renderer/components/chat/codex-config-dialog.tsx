import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatConfig } from "../../../../packages/remote-protocol/src";
import {
  CODEX_CONFIG_PROFILE_KEY,
  type CodexConfigSet,
  codexNumericConfigValue,
} from "../../services/chat/codex-config";
import { SettingsGroup, SettingsRow } from "../settings/section";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { showToast } from "../ui/toast";

export interface CodexDefaultsSource {
  readDefaults(): Promise<ChatConfig>;
  saveDefaults(set: CodexConfigSet): Promise<void>;
}

type Loaded = "loading" | { failed: string } | ChatConfig;

export function CodexDefaultsDialog({
  source,
  open,
  onClose,
}: {
  source: CodexDefaultsSource;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>("loading");
  const [draft, setDraft] = useState<Record<string, string | undefined>>({});
  const [effort, setEffort] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded("loading");
    setDraft({});
    setEffort(undefined);
    setBusy(false);
    source.readDefaults().then(
      (defaults) => live && setLoaded(defaults),
      (err: Error) => live && setLoaded({ failed: err.message }),
    );
    return () => {
      live = false;
    };
  }, [source, open]);

  const now = typeof loaded === "object" && !("failed" in loaded) ? loaded : null;
  const model = now?.keys.find((key) => key.key === "model")?.value;
  const chosen = draft.model ?? model;
  const levels = now?.models.find((m) => m.value === chosen)?.supportedEffortLevels ?? [];
  const changes: CodexConfigSet["changes"] = {};
  const invalid = new Set<string>();
  for (const { key, kind, value, options, valueUnavailable } of now?.keys ?? []) {
    const pick = draft[key];
    if (pick === undefined || pick === value) continue;
    if (kind === "text" && options?.length !== 0) {
      if (codexNumericConfigValue(key, pick) === undefined) invalid.add(key);
      else if (pick !== "" || value !== undefined || valueUnavailable) changes[key] = pick;
    }
    if (kind === "choice" && options?.includes(pick) && (pick !== "default" || value !== undefined))
      changes[key] = pick;
  }
  const changedEffort =
    effort && effort !== now?.efforts?.level && levels.includes(effort) ? effort : undefined;
  const changed = Object.keys(changes).length + Number(changedEffort !== undefined);

  const apply = async () => {
    setBusy(true);
    try {
      const profileId = now?.keys.find((key) => key.key === CODEX_CONFIG_PROFILE_KEY)?.value;
      await source.saveDefaults({
        changes:
          typeof profileId === "string"
            ? { ...changes, [CODEX_CONFIG_PROFILE_KEY]: profileId }
            : changes,
        ...(changedEffort ? { effort: changedEffort } : {}),
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

  const pick = (key: string, value?: string) => {
    setDraft((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "model"
        ? { service_tier: undefined, plan_mode_reasoning_effort: undefined }
        : {}),
    }));
    if (key === "model") setEffort(undefined);
  };

  const renderSetting = (setting: ChatConfig["keys"][number]) => {
    const { key } = setting;
    if (key === CODEX_CONFIG_PROFILE_KEY) return null;
    return (
      <CodexConfigRow
        key={key}
        setting={setting}
        draft={draft[key]}
        models={now?.models}
        busy={busy}
        dirty={changes[key] !== undefined}
        invalid={invalid.has(key)}
        modelChanged={Boolean(changes.model)}
        onChange={(value) => pick(key, value)}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()} size="md">
      <DialogHeader
        title={t("chat.config.codex.title")}
        description={t("chat.config.codex.description")}
        close
      />
      <div className="mt-4 max-h-[55vh] overflow-y-auto" data-testid="codex-config">
        {loaded === "loading" ? (
          <div className="py-8 text-center text-app-ui-sm text-muted-foreground">
            {t("chat.config.loading")}
          </div>
        ) : "failed" in loaded ? (
          <div className="py-8 text-center text-app-ui-sm text-[var(--state-error-fg)]">
            {t("chat.config.read_failed", { error: loaded.failed })}
          </div>
        ) : (
          <>
            <SettingsGroup title={t("chat.config.group.conversation")}>
              {loaded.keys.filter((key) => key.key === "model").map(renderSetting)}
              {loaded.efforts && (levels.length > 0 || loaded.efforts.level) && (
                <DefaultChoice
                  label={t("chat.config.codex.effort")}
                  value={effort ?? loaded.efforts.level}
                  options={levels}
                  busy={busy}
                  dirty={changedEffort !== undefined}
                  onChange={setEffort}
                />
              )}
              {loaded.keys
                .filter((key) => key.group === "conversation" && key.key !== "model")
                .map(renderSetting)}
            </SettingsGroup>
            {loaded.keys.some((key) => key.group === "work") && (
              <SettingsGroup title={t("chat.config.group.work")}>
                {loaded.keys.filter((key) => key.group === "work").map(renderSetting)}
              </SettingsGroup>
            )}
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => void apply()}
          disabled={busy || changed === 0 || invalid.size > 0}
          data-testid="codex-config-apply"
        >
          {changed > 0 ? t("chat.config.apply_count", { count: changed }) : t("action.apply")}
        </Button>
      </div>
    </Dialog>
  );
}

export function CodexConfigRow({
  setting,
  draft,
  models,
  busy,
  dirty,
  invalid,
  modelChanged,
  onChange,
}: {
  setting: ChatConfig["keys"][number];
  draft?: string;
  models?: ChatConfig["models"];
  busy: boolean;
  dirty: boolean;
  invalid: boolean;
  modelChanged: boolean;
  onChange: (value?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { key, kind, value, options, valueUnavailable } = setting;
  const label =
    key === "model"
      ? t("chat.config.key.model")
      : t(`chat.config.codex.keys.${key}`, { defaultValue: key });
  const descriptionKey = `chat.config.codex.descriptions.${key}`;
  const description = i18n.exists(descriptionKey) ? t(descriptionKey) : undefined;
  const current = typeof value === "string" ? value : undefined;

  if (kind === "text") {
    return (
      <SettingsRow
        label={label}
        htmlFor={id}
        description={
          invalid
            ? t(`chat.config.codex.invalid.${key}`, {
                defaultValue: t("chat.config.codex.invalid.tokens"),
              })
            : description
        }
        dirty={dirty || invalid}
        onReset={() => onChange()}
      >
        <div className="flex flex-col items-end gap-1">
          <input
            id={id}
            type="text"
            inputMode="numeric"
            value={draft ?? current ?? ""}
            maxLength={1000}
            disabled={busy || options?.length === 0}
            aria-invalid={invalid || undefined}
            spellCheck={false}
            placeholder={
              valueUnavailable && draft === undefined
                ? t("chat.config.codex.out_of_range")
                : t("chat.config.codex.automatic")
            }
            onChange={(event) => onChange(event.target.value)}
            className="w-44 rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          {(current !== undefined || valueUnavailable) && options?.length !== 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || draft === ""}
              onClick={() => onChange("")}
            >
              {t("chat.config.codex.use_default")}
            </Button>
          )}
        </div>
      </SettingsRow>
    );
  }
  if (kind !== "choice") return null;
  return (
    <DefaultChoice
      label={label}
      description={description}
      value={draft ?? current}
      options={
        (key === "service_tier" || key === "plan_mode_reasoning_effort") && modelChanged
          ? []
          : (options ?? [])
      }
      busy={busy}
      dirty={dirty}
      onChange={onChange}
      describe={(option) =>
        key === "model"
          ? (models?.find((m) => m.value === option)?.displayName ?? option)
          : t(`chat.config.codex.options.${key}.${option}`, {
              defaultValue: option === "default" ? t("chat.config.codex.use_default") : option,
            })
      }
    />
  );
}

function DefaultChoice({
  label,
  description,
  value,
  options,
  busy,
  dirty,
  onChange,
  describe = (value) => value,
}: {
  label: string;
  description?: string;
  value?: string;
  options: readonly string[];
  busy: boolean;
  dirty: boolean;
  onChange: (value?: string) => void;
  describe?: (value: string) => string;
}) {
  const { t } = useTranslation();
  const currentOnly = value && !options.includes(value) ? value : undefined;
  return (
    <SettingsRow
      label={label}
      description={description}
      dirty={dirty}
      onReset={() => onChange(undefined)}
    >
      <Select value={value ?? ""} onValueChange={onChange} disabled={busy || options.length === 0}>
        <SelectTrigger ariaLabel={label} className="w-44">
          <SelectValue placeholder={t("chat.config.default")} />
        </SelectTrigger>
        <SelectContent>
          {currentOnly && (
            <SelectItem value={currentOnly} disabled>
              {describe(currentOnly)}
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {describe(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
