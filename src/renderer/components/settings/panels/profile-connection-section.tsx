import { ChevronRight, Plus, X } from "lucide-react";
import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  CONNECTION_AUTH,
  CONNECTION_METHODS,
  CONNECTION_REASONING,
  type ConnectionModel,
  type ConnectionPreset,
  connectionPresetsFor,
} from "../../../../shared/agent-profiles/connection";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { Button } from "../../ui/button";
import type { ProfileConnectionDraft } from "./use-profile-connection";

const inputClass =
  "min-w-0 w-full rounded-(--radius-control) border border-border bg-background px-2.5 py-1.5 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring";

const hintClass = "text-app-ui-sm text-muted-foreground";
const successClass = "text-app-ui-sm text-[var(--state-success-fg)]";
const errorClass = "text-app-ui-sm text-[var(--state-error-fg)]";
const presetNames: Record<ConnectionPreset, string> = {
  openrouter: "OpenRouter",
  zai: "z.ai",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  minimax: "MiniMax",
  litellm: "LiteLLM",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  strata: "Strata",
};

function Label({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className={hintClass} htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": hintId })}
      {hint && (
        <span id={hintId} className={hintClass}>
          {hint}
        </span>
      )}
    </div>
  );
}

function SettingName({ children }: { children: ReactNode }) {
  return (
    <code className="ml-1 rounded bg-muted px-1 text-app-micro text-muted-foreground">
      {children}
    </code>
  );
}

function NumberField({
  id,
  "aria-describedby": hint,
  label,
  value,
  onChange,
  placeholder,
  min = 1,
}: {
  id?: string;
  "aria-describedby"?: string;
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  min?: number;
}) {
  return (
    <input
      id={id}
      type="number"
      aria-label={label}
      aria-describedby={hint}
      min={min}
      max={2_147_483_647}
      step={1}
      value={value ?? ""}
      className={cn(inputClass, "font-mono")}
      placeholder={placeholder}
      onChange={(event) =>
        onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)
      }
    />
  );
}

export function ProfileConnectionSection({
  agent,
  draft,
}: {
  agent: ChatAgent;
  draft: ProfileConnectionDraft;
}) {
  const { t } = useTranslation("settings");
  const group = useId();
  const custom = draft.method === "custom";
  const claude = agent === "claude";
  const presets = connectionPresetsFor(agent);
  return (
    <>
      <fieldset className="min-w-0 border-t border-border pt-3">
        <legend className="mb-1 text-app-body font-semibold">
          {t("profiles.connection.method")}
        </legend>
        <div className="overflow-hidden rounded-(--radius-control) border border-border bg-background">
          {CONNECTION_METHODS.map((method) => (
            <label
              key={method}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 border-b border-border px-3 py-2 last:border-b-0",
                draft.method === method && "bg-primary/15",
              )}
            >
              <input
                type="radio"
                name={group}
                className="mt-0.5 size-4"
                checked={draft.method === method}
                onChange={() => draft.changeMethod(method)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-app-body font-medium">
                  {t(`profiles.connection.methods.${method}.${agent}.label`)}
                </span>
                <span className={hintClass}>
                  {t(`profiles.connection.methods.${method}.${agent}.hint`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.method !== "account" && (
        <section className="flex flex-col gap-2.5 border-t border-border pt-3">
          <h3 className="text-app-body font-semibold">
            {t(custom ? "profiles.connection.addressAndKey" : "profiles.connection.key")}
          </h3>
          {custom && (
            <>
              {!claude && (
                <p className="rounded-(--radius-control) border border-border bg-muted/50 px-2.5 py-2 text-app-ui-sm">
                  {t("profiles.connection.responsesHint")}
                </p>
              )}
              <div>
                <div className={cn(hintClass, "mb-1")}>{t("profiles.connection.presets")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {[...presets, undefined].map((value) => (
                    <button
                      key={value ?? "manual"}
                      type="button"
                      aria-pressed={value === draft.preset}
                      onClick={() => draft.choosePreset(value)}
                      className={cn(
                        "rounded-full border border-border px-2.5 py-1 text-app-ui-sm hover:bg-muted",
                        value === draft.preset && "border-ring bg-muted",
                      )}
                    >
                      {value ? presetNames[value] : t("profiles.connection.manual")}
                    </button>
                  ))}
                </div>
              </div>
              <Label
                label={
                  <>
                    {t("profiles.connection.address")}
                    <SettingName>{claude ? "ANTHROPIC_BASE_URL" : "base_url"}</SettingName>
                  </>
                }
              >
                <input
                  value={draft.baseUrl}
                  maxLength={2048}
                  onChange={(event) => draft.setBaseUrl(event.target.value)}
                  onBlur={draft.confirmAddress}
                  spellCheck={false}
                  className={cn(inputClass, "font-mono")}
                  aria-invalid={Boolean(draft.baseUrl && !draft.address)}
                  placeholder={claude ? "https://llm.example.com" : "http://192.168.0.20:8000/v1"}
                />
              </Label>
              {draft.baseUrl && !draft.address && (
                <p className={errorClass}>{t("profiles.connection.errors.address")}</p>
              )}
            </>
          )}
          <div className="flex flex-wrap items-start gap-2.5">
            <div className="min-w-52 flex-1">
              <Label label={t("profiles.connection.key")}>
                <input
                  type="password"
                  value={draft.key ?? ""}
                  maxLength={4096}
                  placeholder={
                    draft.keyPlaceholder ??
                    (custom ? t("profiles.connection.keyOptional") : t("profiles.connection.key"))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    inputClass,
                    "font-mono",
                    !draft.keyPlaceholder && "placeholder:font-sans",
                  )}
                  onChange={(event) =>
                    draft.setKey(
                      event.target.value || (draft.keyStatus?.present ? null : undefined),
                    )
                  }
                  aria-invalid={!draft.keyValid}
                />
              </Label>
            </div>
            {custom && claude && (
              <fieldset>
                <legend className={cn(hintClass, "mb-1")}>{t("profiles.connection.auth")}</legend>
                <div className="flex overflow-hidden rounded-(--radius-control) border border-border">
                  {CONNECTION_AUTH.map((auth) => (
                    <button
                      type="button"
                      key={auth}
                      aria-pressed={draft.auth === auth}
                      onClick={() => draft.setAuth(auth)}
                      className={cn(
                        "px-2.5 py-1.5 text-app-ui-sm",
                        draft.auth === auth && "bg-primary text-primary-foreground",
                      )}
                    >
                      {auth === "bearer" ? t("profiles.connection.bearer") : "x-api-key"}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {(draft.keyPlaceholder || draft.key) && (
              <Button
                type="button"
                className="mt-5"
                variant="ghost"
                size="sm"
                onClick={() => draft.setKey(null)}
              >
                {t("profiles.connection.clearKey")}
              </Button>
            )}
          </div>
          <p className={hintClass}>
            {draft.keyStatus?.persistent === false
              ? t("profiles.connection.memoryKey")
              : t("profiles.connection.sealedKey")}
          </p>
        </section>
      )}

      {custom && <ProfileConnectionModels agent={agent} draft={draft} />}
    </>
  );
}

function ProfileConnectionModels({
  agent,
  draft,
}: {
  agent: ChatAgent;
  draft: ProfileConnectionDraft;
}) {
  const { t } = useTranslation("settings");
  const group = useId();
  const models = draft.discovery?.ok ? draft.discovery.models : [];
  const claude = agent === "claude";
  const grid = cn(
    "grid items-center gap-1.5",
    claude
      ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.5rem_3rem_1.5rem]"
      : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem_6.5rem_3rem_1.5rem]",
  );
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-app-body font-semibold">{t("profiles.connection.models")}</h3>
        {models.length > 0 && (
          <span className={successClass}>
            {t("profiles.connection.found", { count: models.length })}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!draft.address || draft.looking}
          onClick={draft.findModels}
        >
          {draft.looking
            ? t("profiles.connection.looking")
            : draft.discovery
              ? t("profiles.connection.findAgain")
              : t("profiles.connection.find")}
        </Button>
      </div>
      <p className={hintClass}>{t("profiles.connection.localCheck")}</p>
      {draft.discovery && models.length === 0 && (
        <p role="status" className={hintClass}>
          {draft.isLocal && !draft.discovery.ok && draft.discovery.reason === "network"
            ? t("profiles.connection.notRunning")
            : !draft.discovery.ok && draft.discovery.reason === "auth"
              ? t("profiles.connection.errors.auth")
              : t("profiles.connection.noModels")}
        </p>
      )}
      {draft.isLocal && models.length > 1 && (
        <div className="app-scrollbar max-h-36 overflow-auto rounded-(--radius-control) border border-dashed border-border p-2">
          {models.map((model) => (
            <label key={model.id} className="flex items-center gap-2 py-0.5 text-app-ui-sm">
              <input
                type="checkbox"
                checked={draft.rows.some(({ id }) => id === model.id)}
                onChange={() => draft.toggleDiscovered(model)}
              />
              <span className="min-w-0 truncate font-mono" title={model.id}>
                {model.id}
              </span>
              {model.bytes !== undefined && (
                <span className={cn(hintClass, "ml-auto shrink-0")}>
                  {t("profiles.connection.gigabytes", { size: (model.bytes / 1e9).toFixed(1) })}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <div aria-hidden="true" className={cn(grid, hintClass)}>
        <span>{t("profiles.connection.modelId")}</span>
        <span>{t("profiles.connection.label")}</span>
        {!claude && <span>{t("profiles.connection.context")}</span>}
        <span>{t("profiles.connection.reasoning")}</span>
        <span className="text-center">{t("profiles.connection.default")}</span>
        <span />
      </div>
      <datalist id={group}>
        {models.map(({ id, label }) => (
          <option key={id} value={id} label={label} />
        ))}
      </datalist>
      {draft.rows.map((row) => (
        <div key={row.rowId} className={grid}>
          <input
            aria-label={t("profiles.connection.modelId")}
            value={row.id}
            maxLength={256}
            list={group}
            spellCheck={false}
            onChange={(event) => draft.updateModel(row.rowId, { id: event.target.value })}
            className={cn(inputClass, "font-mono")}
          />
          <input
            aria-label={t("profiles.connection.label")}
            value={row.label ?? ""}
            maxLength={128}
            spellCheck={false}
            onChange={(event) => draft.updateModel(row.rowId, { label: event.target.value })}
            className={inputClass}
          />
          {!claude && (
            <NumberField
              label={t("profiles.connection.context")}
              value={row.contextWindow}
              placeholder="131072"
              onChange={(value) => draft.updateModel(row.rowId, { contextWindow: value })}
            />
          )}
          <select
            aria-label={t("profiles.connection.reasoning")}
            value={row.reasoning ?? (claude ? "auto" : "none")}
            className={cn(inputClass, "px-1")}
            onChange={(event) => {
              const value = event.target.value;
              draft.updateModel(row.rowId, {
                reasoning:
                  claude && value === "auto" ? undefined : (value as ConnectionModel["reasoning"]),
              });
            }}
          >
            {claude && <option value="auto">{t("profiles.connection.effort.auto")}</option>}
            {CONNECTION_REASONING.map((value) => (
              <option key={value} value={value}>
                {t(`profiles.connection.effort.${value}`)}
              </option>
            ))}
          </select>
          <input
            type="radio"
            name={`${group}-default`}
            aria-label={t("profiles.connection.default")}
            className="mx-auto size-4"
            checked={row.rowId === draft.defaultRowId}
            onChange={() => draft.setDefaultRowId(row.rowId)}
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label={t("profiles.connection.removeModel")}
            onClick={() => draft.removeModel(row.rowId)}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      {draft.reasoningModelIdError && (
        <p className={errorClass}>{t("profiles.connection.errors.reasoningModelId")}</p>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        type="button"
        disabled={draft.rows.length >= 128}
        onClick={draft.addModel}
      >
        <Plus />
        {t("profiles.connection.addModel")}
      </Button>
      {claude && (
        <div className="grid grid-cols-2 gap-3">
          <Label
            label={t("profiles.connection.lightModel")}
            hint={t("profiles.connection.lightHint")}
          >
            <select
              value={draft.lightRowId ?? ""}
              onChange={(event) => draft.setLightRowId(event.target.value || undefined)}
              className={inputClass}
            >
              <option value="">{t("profiles.connection.default")}</option>
              {draft.rows
                .filter(({ id }) => id.trim())
                .map((row) => (
                  <option key={row.rowId} value={row.rowId}>
                    {row.label || row.id}
                  </option>
                ))}
            </select>
          </Label>
          <Label
            label={t("profiles.connection.context")}
            hint={t("profiles.connection.contextHint")}
          >
            <NumberField
              label={t("profiles.connection.context")}
              value={draft.contextWindow}
              onChange={draft.setContextWindow}
              placeholder="1000000"
            />
          </Label>
        </div>
      )}
    </section>
  );
}

export function ProfileConnectionAdvanced({
  agent,
  draft,
  children,
}: {
  agent: ChatAgent;
  draft: ProfileConnectionDraft;
  children: ReactNode;
}) {
  const { t } = useTranslation("settings");
  const claude = agent === "claude";
  const custom = draft.method === "custom";
  return (
    <details className="group border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-app-body font-semibold">
        <ChevronRight
          className="size-3.5 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {t("profiles.connection.advanced")}
        {custom && (
          <span className={cn(hintClass, "font-normal")}>
            {t(`profiles.connection.advancedHint.${agent}`)}
          </span>
        )}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {custom && (
          <>
            <Label
              label={t("profiles.connection.headers")}
              hint={draft.headers === null ? t("profiles.connection.headersInvalid") : undefined}
            >
              <textarea
                rows={2}
                value={draft.headersText}
                placeholder="Header-Name: value"
                className={cn(inputClass, "resize-y font-mono")}
                onChange={(event) => draft.setHeadersText(event.target.value)}
              />
            </Label>
            {!claude && (
              <Label
                label={t("profiles.connection.query")}
                hint={draft.query === null ? t("profiles.connection.queryInvalid") : undefined}
              >
                <textarea
                  rows={2}
                  value={draft.queryText}
                  placeholder="api-version=value"
                  className={cn(inputClass, "resize-y font-mono")}
                  onChange={(event) => draft.setQueryText(event.target.value)}
                />
              </Label>
            )}
            <div className="grid grid-cols-2 gap-3">
              {claude ? (
                <>
                  <Label label={t("profiles.connection.timeout")}>
                    <NumberField
                      label={t("profiles.connection.timeout")}
                      value={draft.advanced.timeoutMs}
                      onChange={(timeoutMs) => draft.setAdvanced({ ...draft.advanced, timeoutMs })}
                    />
                  </Label>
                  <Label label={t("profiles.connection.outputTokens")}>
                    <NumberField
                      label={t("profiles.connection.outputTokens")}
                      value={draft.advanced.maxOutputTokens}
                      onChange={(maxOutputTokens) =>
                        draft.setAdvanced({ ...draft.advanced, maxOutputTokens })
                      }
                    />
                  </Label>
                </>
              ) : (
                <>
                  <Label label={t("profiles.connection.retries")}>
                    <NumberField
                      label={t("profiles.connection.retries")}
                      value={draft.advanced.retries}
                      min={0}
                      onChange={(retries) => draft.setAdvanced({ ...draft.advanced, retries })}
                    />
                  </Label>
                  <Label label={t("profiles.connection.streamTimeout")}>
                    <NumberField
                      label={t("profiles.connection.streamTimeout")}
                      value={draft.advanced.streamIdleTimeoutMs}
                      onChange={(streamIdleTimeoutMs) =>
                        draft.setAdvanced({ ...draft.advanced, streamIdleTimeoutMs })
                      }
                    />
                  </Label>
                </>
              )}
            </div>
            {claude && (
              <label className={cn(hintClass, "flex items-center gap-2")}>
                <input
                  type="checkbox"
                  checked={draft.advanced.disableExperimentalBetas ?? false}
                  onChange={(event) =>
                    draft.setAdvanced({
                      ...draft.advanced,
                      disableExperimentalBetas: event.target.checked,
                    })
                  }
                />
                {t("profiles.connection.disableBetas")}
              </label>
            )}
          </>
        )}
        {children}
        {draft.method !== "account" && (
          <p className={hintClass}>{t("profiles.connection.envPriority")}</p>
        )}
      </div>
    </details>
  );
}

export function ProfileConnectionTest({ draft }: { draft: ProfileConnectionDraft }) {
  const { t } = useTranslation("settings");
  if (draft.method !== "custom") return null;
  const result = draft.testResult;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => void draft.test()}
        disabled={!draft.canTest || draft.testing}
        title={t("profiles.connection.testHint")}
      >
        {draft.testing ? t("profiles.connection.testing") : t("profiles.connection.test")}
      </Button>
      {result && (
        <span role="status" className={result.ok ? successClass : errorClass}>
          {result.ok
            ? t("profiles.connection.tested", { ms: result.ms, model: draft.defaultModel })
            : t(`profiles.connection.errors.${result.reason}`, { model: draft.defaultModel })}
          {!result.ok && result.status ? ` · HTTP ${result.status}` : ""}
        </span>
      )}
    </div>
  );
}
