/**
 * The "Behavior" fold at the bottom of a profile's dialog: the values of the
 * agent's own config file in the profile's folder (settings.json, config.toml)
 * that Settings edits. Nothing is written until the dialog saves; only the
 * values changed are. The file is read again when it changes outside.
 */

import { ChevronRight } from "lucide-react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  BEHAVIOR_FIELDS,
  type BehaviorField,
  type BehaviorFile,
  type BehaviorValue,
} from "../../../../shared/agent-profiles/behavior";
import type { AgentProfile } from "../../../../shared/agent-profiles/profiles";
import { ipcCallResult } from "../../../ipc/client";
import { tildePath } from "../../../state/stores/agent-profiles";
import { isWindows } from "../../../utils/platform";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsRow, SettingsSwitch } from "../section";
import { SegmentedControl } from "../segmented-control";

const POLL_MS = 2000;
/** Radix Select takes no empty item value: the default option is this. */
const DEFAULT_VALUE = "__default";

/** What the connection the dialog edits makes of the fields; the dialog passes it once connections exist. */
export interface BehaviorConnection {
  /** Claude's starting model is locked (another API address): the text shown in its place. */
  modelLocked?: string;
  /** Codex's web search is locked: the text shown in its place. */
  webSearchLocked?: string;
  /** Codex's answer length is hidden (not a GPT model). */
  hideVerbosity?: boolean;
}

export interface BehaviorSectionHandle {
  /** Writes the values changed; false when nothing was written and the dialog should stay open. */
  save(): Promise<boolean>;
}

type Draft = Record<string, BehaviorValue | null>;

const inputClass = cn(
  "w-48 rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
);

function Group({ title }: { title: string }) {
  return <div className="mt-3 text-app-ui-sm text-muted-foreground">{title}</div>;
}

export function ProfileBehaviorSection({
  profile,
  connection,
  onUnshared,
  handleRef,
}: {
  profile: AgentProfile;
  connection?: BehaviorConnection;
  /** The profile's file is its own now: the dialog drops it from what the profile shares. */
  onUnshared: (name: string) => Promise<void>;
  handleRef: Ref<BehaviorSectionHandle>;
}) {
  const { t } = useTranslation("settings");
  const agent = profile.agent;
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<BehaviorFile | null>(null);
  const [latest, setLatest] = useState<BehaviorFile | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [ownBadge, setOwnBadge] = useState(false);
  const fileRef = useRef(file);
  fileRef.current = file;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const read = useCallback(
    async (prepare: boolean): Promise<BehaviorFile | null> => {
      const result = await ipcCallResult("agentProfiles", "readBehavior", {
        profileId: profile.id,
        prepare,
      });
      return result.ok ? result.value : null;
    },
    [profile.id],
  );

  // Read when opened; look again while it stays open, for a change from outside.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const apply = (next: BehaviorFile | null, first: boolean) => {
      if (!live || !next) return;
      const current = fileRef.current;
      if (first || current === null) {
        setFile(next);
        setLatest(null);
      } else if (next.version !== current.version) {
        if (Object.keys(draftRef.current).length === 0) {
          setFile(next);
          setLatest(null);
        } else setLatest(next);
      } else setLatest(null);
    };
    void read(true).then((next) => apply(next, true));
    const timer = setInterval(() => {
      if (!document.hidden) void read(false).then((next) => apply(next, false));
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, read]);

  const fields = BEHAVIOR_FIELDS.filter((f) => f.agent === agent);
  const fieldOf = (id: string): BehaviorField => fields.find((f) => f.id === id) as BehaviorField;

  /** The value a field shows: the edit, else the file's, else its default. */
  const shownValue = (id: string): BehaviorValue | undefined => {
    if (id in draft) return draft[id] ?? undefined;
    return file?.values[id];
  };
  const boolOf = (id: string): boolean => {
    const v = shownValue(id);
    return typeof v === "boolean" ? v : fieldOf(id).fallback === true;
  };
  const edit = (id: string, value: BehaviorValue | null) => {
    setError(null);
    setDraft((prev) => {
      const next = { ...prev };
      // Back to what the file has: not a change.
      const base = file?.values[id];
      const same = value === null ? base === undefined : value === base;
      if (same) delete next[id];
      else next[id] = value;
      return next;
    });
  };

  useImperativeHandle(
    handleRef,
    () => ({
      async save() {
        const current = fileRef.current;
        const changes = draftRef.current;
        if (!current || Object.keys(changes).length === 0) return true;
        if (current.broken) return false;
        const result = await ipcCallResult("agentProfiles", "writeBehavior", {
          profileId: profile.id,
          version: current.version,
          changes,
        });
        if (!result.ok) {
          setError(t("profiles.behavior.saveFailed", { message: result.message }));
          return false;
        }
        const done = result.value;
        if (done.status === "saved") {
          setDraft({});
          setLatest(null);
          setFile(await read(false));
          return true;
        }
        if (done.status === "conflict") {
          setError(t("profiles.behavior.conflict"));
          setLatest(await read(false));
        } else if (done.status === "broken") {
          setError(t("profiles.behavior.saveFailed", { message: done.message }));
        } else {
          const names = done.fields.map((id) => t(`profiles.behavior.fields.${id}.label`));
          setError(t("profiles.behavior.unsupportedSave", { fields: names.join(", ") }));
        }
        return false;
      },
    }),
    [profile.id, read, t],
  );

  const reload = () => {
    if (latest) {
      setFile(latest);
      setLatest(null);
      setError(null);
      // An edit the file has now is not one.
      setDraft((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(([id, value]) =>
            value === null ? latest.values[id] !== undefined : latest.values[id] !== value,
          ),
        ),
      );
    }
  };

  const unshare = async () => {
    if (!file) return;
    const confirmed = await showConfirmDialog({
      title: t("profiles.behavior.shared.confirmTitle", { file: file.name }),
      description: t("profiles.behavior.shared.confirmBody"),
      confirmLabel: t("profiles.behavior.shared.confirm"),
    });
    if (!confirmed) return;
    const result = await ipcCallResult("agentProfiles", "unshareBehavior", {
      profileId: profile.id,
    });
    if (!result.ok) {
      setError(t("profiles.behavior.shared.failed", { message: result.message }));
      return;
    }
    await onUnshared(file.name);
    setOwnBadge(true);
    setFile(await read(false));
    setLatest(null);
  };

  const openFile = () => {
    if (file) void ipcCallResult("system", "openPathExternal", { absPath: file.path });
  };

  // ------------------------------------------------------------------

  const fieldLabel = (id: string) => t(`profiles.behavior.fields.${id}.label`);
  const fieldHint = (id: string) => {
    const hint = t(`profiles.behavior.fields.${id}.hint`);
    return hint === "" ? undefined : hint;
  };
  const optionLabel = (id: string, value: string) =>
    t(`profiles.behavior.options.${id}.${value}`, { defaultValue: value });
  const unsupported = (id: string) => file?.unsupported.includes(id) === true;
  const dirty = (id: string) => id in draft;
  const reset = (id: string) =>
    id in draft ? () => edit(id, file?.values[id] ?? null) : undefined;

  /** A dropdown of the field's options and "default"; a value the file has that is not one is kept as an option. */
  const choice = (id: string, extra: readonly string[] = [], locked?: string) => {
    const field = fieldOf(id);
    const current = shownValue(id);
    const options = [...(field.options ?? []), ...extra];
    if (typeof current === "string" && current !== "" && !options.includes(current))
      options.push(current);
    const defaultLabel =
      field.fallback !== undefined
        ? optionLabel(id, String(field.fallback))
        : id === "model"
          ? t("profiles.behavior.defaultAccount")
          : t("profiles.behavior.default");
    const shown = typeof current === "string" && current !== "" ? current : DEFAULT_VALUE;
    const effective = shown === String(field.fallback) ? DEFAULT_VALUE : shown;
    return (
      <SettingsRow
        label={fieldLabel(id)}
        code={field.path.join(".")}
        description={
          unsupported(id) ? t("profiles.behavior.unsupported") : (locked ?? fieldHint(id))
        }
        dirty={dirty(id)}
        onReset={reset(id)}
      >
        <Select
          value={effective}
          disabled={locked !== undefined || unsupported(id)}
          onValueChange={(v) => edit(id, v === DEFAULT_VALUE ? null : v)}
        >
          <SelectTrigger className="w-48" ariaLabel={fieldLabel(id)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem>
            {options
              .filter((o) => o !== String(field.fallback))
              .map((o) => (
                <SelectItem key={o} value={o}>
                  {optionLabel(id, o)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    );
  };

  const toggle = (id: string) => (
    <SettingsSwitch
      label={fieldLabel(id)}
      code={fieldOf(id).path.join(".")}
      description={unsupported(id) ? t("profiles.behavior.unsupported") : fieldHint(id)}
      checked={boolOf(id)}
      disabled={unsupported(id)}
      onChange={(next) => edit(id, next)}
      dirty={dirty(id)}
      onReset={reset(id)}
    />
  );

  const text = (id: string, numeric = false) => {
    const current = shownValue(id);
    return (
      <SettingsRow
        label={fieldLabel(id)}
        code={fieldOf(id).path.join(".")}
        description={unsupported(id) ? t("profiles.behavior.unsupported") : fieldHint(id)}
        dirty={dirty(id)}
        onReset={reset(id)}
      >
        <input
          type="text"
          inputMode={numeric ? "numeric" : undefined}
          value={current === undefined ? "" : String(current)}
          spellCheck={false}
          disabled={unsupported(id)}
          placeholder={t(`profiles.behavior.fields.${id}.placeholder`)}
          aria-label={fieldLabel(id)}
          onChange={(e) => {
            const raw = e.target.value;
            if (!numeric) return edit(id, raw.trim() === "" ? null : raw);
            const digits = raw.replace(/\D/g, "");
            edit(id, digits === "" ? null : Number.parseInt(digits, 10));
          }}
          className={cn(inputClass, numeric && "font-mono")}
        />
      </SettingsRow>
    );
  };

  /** A segmented choice, with "default" first; a value the file has that is not one of them is added. */
  const segmented = (id: string, values: readonly string[]) => {
    const current = shownValue(id);
    const all = [...values];
    if (typeof current === "string" && !all.includes(current)) all.push(current);
    return (
      <SettingsRow
        label={fieldLabel(id)}
        code={fieldOf(id).path.join(".")}
        description={unsupported(id) ? t("profiles.behavior.unsupported") : fieldHint(id)}
        dirty={dirty(id)}
        onReset={reset(id)}
      >
        <SegmentedControl
          label={fieldLabel(id)}
          disabled={unsupported(id)}
          value={typeof current === "string" ? current : DEFAULT_VALUE}
          onChange={(v) => edit(id, v === DEFAULT_VALUE ? null : v)}
          options={[
            { value: DEFAULT_VALUE, label: t("profiles.behavior.default") },
            ...all.map((v) => ({ value: v, label: optionLabel(id, v) })),
          ]}
        />
      </SettingsRow>
    );
  };

  const body = () => {
    if (!file)
      return (
        <p className="text-app-ui-sm text-muted-foreground">{t("profiles.behavior.loading")}</p>
      );
    return (
      <div className="flex flex-col gap-2">
        {file.shared && (
          <div className="flex items-center justify-between gap-3 rounded-(--radius-control) border border-[var(--state-warning-fg)]/40 px-2.5 py-1.5">
            <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
              {t("profiles.behavior.shared.warn", { file: file.name })}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void unshare()}>
              {t("profiles.behavior.shared.unshare")}
            </Button>
          </div>
        )}
        {latest && (
          <div className="flex items-center justify-between gap-3 rounded-(--radius-control) border border-border px-2.5 py-1.5">
            <span className="text-app-ui-sm">{t("profiles.behavior.outside")}</span>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              {t("profiles.behavior.reload")}
            </Button>
          </div>
        )}
        {file.broken ? (
          <p className="text-app-ui-sm text-[var(--state-error-fg)]">
            {t("profiles.behavior.broken", { file: file.name, reason: file.broken })}
          </p>
        ) : agent === "claude" ? (
          <>
            <Group title={t("profiles.behavior.groups.model")} />
            {choice("model", [], connection?.modelLocked)}
            {toggle("thinking")}
            <Group title={t("profiles.behavior.groups.work")} />
            {choice("permissionMode")}
            {text("language")}
            {choice("outputStyle", file.outputStyles)}
            {toggle("autoCompact")}
            {toggle("autoMemory")}
            {toggle("attribution")}
            {!isWindows() && toggle("sandbox")}
          </>
        ) : (
          <>
            <Group title={t("profiles.behavior.groups.permissions")} />
            {segmented("approvalPolicy", ["on-request", "never"])}
            {choice("sandboxMode")}
            {toggle("sandboxNetwork")}
            <Group title={t("profiles.behavior.groups.model")} />
            {text("codexModel")}
            {choice("webSearch", [], connection?.webSearchLocked)}
            {choice("reasoningSummary")}
            {text("autoCompactLimit", true)}
            {!connection?.hideVerbosity && segmented("verbosity", ["low", "medium", "high"])}
          </>
        )}
        {error && <p className="text-app-ui-sm text-[var(--state-error-fg)]">{error}</p>}
        {!file.broken && (
          <>
            <p className="mt-2 text-app-ui-sm text-muted-foreground">
              {t(`profiles.behavior.tabNote.${agent}`)}
            </p>
            <p className="text-app-ui-sm text-muted-foreground">
              {t(`profiles.behavior.footer.${agent}`, { file: file.name })}
            </p>
          </>
        )}
      </div>
    );
  };

  const name = file?.name ?? (agent === "claude" ? "settings.json" : "config.toml");
  return (
    <div className="flex flex-col gap-2" data-testid="profile-behavior">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-app-ui-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          <span className="text-foreground">{t("profiles.behavior.title")}</span>
          {open && file && <span className="font-mono text-app-micro">{tildePath(file.path)}</span>}
          {open && ownBadge && (
            <span className="rounded-full border border-[var(--state-success-fg)]/50 px-1.5 text-app-micro text-[var(--state-success-fg)]">
              {t("profiles.behavior.shared.own")}
            </span>
          )}
        </button>
        {open && file && (
          <Button type="button" variant="outline" size="sm" onClick={openFile}>
            {t("profiles.behavior.openFile", { file: name })}
          </Button>
        )}
      </div>
      {open && (
        <>
          <p className="text-app-ui-sm text-muted-foreground">{t("profiles.behavior.ssh")}</p>
          {body()}
        </>
      )}
    </div>
  );
}
