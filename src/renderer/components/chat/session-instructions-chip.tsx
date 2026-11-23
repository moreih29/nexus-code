import { AlertTriangle, Check, List, Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  InstructionTextSchema,
  instructionLayers,
  mergeAgentInstructions,
  workspaceInstructionTarget,
} from "../../../shared/chat/instructions";
import { instructionProfileOf } from "../../services/chat/agent-tab";
import {
  saveSessionInstructions,
  useAgentInstructionsStore,
} from "../../state/stores/agent-instructions";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { profileName } from "../agent-profiles/profile-badge";
import { InstructionField, InstructionPreview } from "../settings/instruction-field";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { COMPOSER_CHIP_CLASS } from "./composer-chip";

export interface InstructionsTab {
  workspaceId: string;
  tabId: string;
}

export interface InstructionsChipSlot {
  compact: boolean;
  onMenu: (open: boolean) => void;
}

export interface InstructionRow {
  key: string;
  label: string;
  text: string;
  onEdit?: () => void;
}

export interface InstructionsChipViewProps extends InstructionsChipSlot {
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  onOpen?: () => void;
  rows: readonly InstructionRow[];
  rowsNote?: string;
  session: string | undefined;
  save?: (text: string) => Promise<void>;
  combined: (session: string) => string;
  note?: string;
}

export function InstructionsChipView({
  compact,
  onMenu,
  loading = false,
  failed = false,
  onRetry,
  onOpen,
  rows,
  rowsNote,
  session,
  save,
  combined,
  note,
}: InstructionsChipViewProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onMenu(next);
  };
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState<string | undefined>(undefined);
  if (open && session !== base) {
    setBase(session);
    if (draft === (base ?? "")) setDraft(session ?? "");
  }
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const ready = !loading && !failed;
  const count = ready
    ? rows.filter(({ text }) => text !== "").length + (session?.trim() ? 1 : 0)
    : 0;
  const chipLabel =
    count > 0 ? t("instructions.session.chipCount", { count }) : t("instructions.session.chip");

  const apply = async () => {
    if (!save) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await save(draft);
      setOpen(false);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(session ?? "");
          setBase(session);
          setPreview(false);
          setSaveFailed(false);
          onOpen?.();
        }
        setOpen(next);
      }}
      label={t("instructions.session.title")}
      align="start"
      containEvents
      testId="session-instructions-popover"
      className="w-96 max-w-[calc(100vw-1rem)] p-3"
      trigger={
        <button
          type="button"
          className={COMPOSER_CHIP_CLASS}
          aria-label={failed ? t("instructions.session.loadFailed") : chipLabel}
          title={failed ? t("instructions.session.loadFailed") : t("instructions.session.title")}
          data-testid="session-instructions-chip"
          data-instructions={loading ? "loading" : failed ? "failed" : "ready"}
        >
          {failed ? (
            <AlertTriangle className="size-3 text-[var(--state-warning-fg)]" aria-hidden />
          ) : (
            compact && <List className="size-3" aria-hidden />
          )}
          {compact ? (count > 0 ? count : undefined) : chipLabel}
        </button>
      }
    >
      <h3 className="mb-2 text-app-body font-semibold">{t("instructions.session.title")}</h3>
      {loading ? (
        <p className="text-app-ui-sm text-muted-foreground">
          {t("common:agentView.remote.loading")}
        </p>
      ) : failed ? (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-app-ui-sm text-[var(--state-error-fg)]">
            {t("instructions.session.loadFailed")}
          </p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("common:action.retry")}
            </Button>
          )}
        </div>
      ) : (
        <>
          {rows.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {rows.map(({ key, label, text, onEdit }) => (
                <li key={key} className="flex items-center justify-between gap-2">
                  <LayerLine label={label} text={text} />
                  {onEdit && (
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer text-primary hover:underline"
                      onClick={() => {
                        setOpen(false);
                        onEdit();
                      }}
                    >
                      {t(text ? "instructions.session.edit" : "instructions.session.add")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && rowsNote && (
            <p className="mt-1.5 text-app-ui-sm text-muted-foreground">{rowsNote}</p>
          )}
          {session === undefined ? (
            <div className="flex flex-col gap-2">
              <InstructionPreview text={combined("")} />
              {note && <p className="text-app-ui-sm text-muted-foreground">{note}</p>}
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
              <h4 className="text-app-body font-medium">{t("instructions.session.label")}</h4>
              {save ? (
                <InstructionField
                  label={t("instructions.session.label")}
                  text={draft}
                  onChange={setDraft}
                />
              ) : (
                <InstructionPreview text={session} />
              )}
              {saveFailed && (
                <p role="alert" className="text-app-ui-sm text-[var(--state-error-fg)]">
                  {t("instructions.saveFailed")}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-expanded={preview}
                  onClick={() => setPreview(!preview)}
                  className="mr-auto cursor-pointer text-primary hover:underline"
                >
                  {t("instructions.session.preview")}
                </button>
                {save && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOpen(false)}
                      disabled={saving}
                    >
                      {t("common:action.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void apply()}
                      disabled={
                        saving ||
                        draft === session ||
                        !InstructionTextSchema.safeParse(draft).success
                      }
                    >
                      {t("instructions.session.apply")}
                    </Button>
                  </>
                )}
              </div>
              {preview && <InstructionPreview text={combined(save ? draft : session)} />}
              <p className="text-app-ui-sm text-muted-foreground">
                {save ? t("instructions.session.applies") : note}
              </p>
            </div>
          )}
        </>
      )}
    </Popover>
  );
}

function LayerLine({ label, text }: { label: string; text: string }): ReactNode {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {text ? (
        <Check className="size-3 shrink-0 text-[var(--state-success-fg)]" aria-hidden />
      ) : (
        <Minus className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-app-micro text-muted-foreground">
        {text
          ? t("instructions.session.lines", { count: text.split("\n").length })
          : t("instructions.session.emptyLayer")}
      </span>
    </div>
  );
}

export function SessionInstructionsChip({
  workspaceId,
  tabId,
  compact,
  onMenu,
}: InstructionsTab & InstructionsChipSlot) {
  const { t } = useTranslation(["settings", "common"]);
  const config = useAgentInstructionsStore((state) => state.config);
  const profiles = useAgentProfilesStore((state) => state.config);
  const workspace = useWorkspacesStore((state) =>
    workspaceInstructionTarget(
      state.workspaces.find(({ id }) => id === workspaceId),
      state.workspaces,
    ),
  );
  const tab = useTabsStore((state) => state.byWorkspace[workspaceId]?.[tabId]);
  if (tab?.type !== "claude" && tab?.type !== "codex") return null;

  const agent = tab.type;
  const profile = instructionProfileOf(profiles, agent, tab.props.profileId);
  const session = tab.props.instructions ?? "";
  const target = { agent, profile, workspace, session };
  const rows = instructionLayers(config, target).flatMap(({ scope, title, text }) => {
    if (scope === null) return [];
    const label =
      scope.kind === "profile"
        ? t("instructions.session.profile", { name: profileName(profile, t) })
        : scope.kind === "workspace"
          ? t("instructions.session.workspace", { name: workspace?.name })
          : scope.kind === "all"
            ? t("instructions.all")
            : title;
    return [
      {
        key: title,
        label,
        text,
        onEdit: () => useSettingsUIStore.getState().openInstructions(scope),
      },
    ];
  });

  return (
    <InstructionsChipView
      compact={compact}
      onMenu={onMenu}
      rows={rows}
      session={session}
      save={(text) => saveSessionInstructions(workspaceId, tabId, text)}
      combined={(draft) => mergeAgentInstructions(config, { ...target, session: draft })}
    />
  );
}
