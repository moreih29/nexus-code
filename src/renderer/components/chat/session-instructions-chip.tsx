import { Check, List, Minus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  InstructionTextSchema,
  instructionLayers,
  mergeAgentInstructions,
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
import { cn } from "../../utils/cn";
import { profileName } from "../agent-profiles/profile-badge";
import { InstructionField, InstructionPreview } from "../settings/instruction-field";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

export interface InstructionsTab {
  workspaceId: string;
  tabId: string;
}

export function SessionInstructionsChip({
  workspaceId,
  tabId,
  compact,
}: InstructionsTab & { compact: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const config = useAgentInstructionsStore((state) => state.config);
  const profiles = useAgentProfilesStore((state) => state.config);
  const workspace = useWorkspacesStore((state) =>
    state.workspaces.find(({ id }) => id === workspaceId),
  );
  const tab = useTabsStore((state) => state.byWorkspace[workspaceId]?.[tabId]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  if (tab?.type !== "claude" && tab?.type !== "codex") return null;

  const agent = tab.type;
  const profile = instructionProfileOf(profiles, agent, tab.props.profileId);
  const session = tab.props.instructions ?? "";
  const target = { agent, profile, workspace, session };
  const layers = instructionLayers(config, target);
  const count = layers.filter(({ text }) => text !== "").length;
  const chipLabel =
    count > 0 ? t("instructions.session.chipCount", { count }) : t("instructions.session.chip");

  const apply = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await saveSessionInstructions(workspaceId, tabId, draft.trim() ? draft : "");
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(session);
          setPreview(false);
          setFailed(false);
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
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1 rounded-(--radius-pill) border px-1.5 py-0.5 text-app-ui-sm focus-visible:ring-1 focus-visible:ring-ring",
            count > 0 || open
              ? "border-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)] text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
          aria-label={chipLabel}
          title={t("instructions.session.title")}
          data-testid="session-instructions-chip"
        >
          <List className="size-3" aria-hidden />
          {compact ? (count > 0 ? count : undefined) : chipLabel}
        </button>
      }
    >
      <h3 className="mb-2 text-app-body font-semibold">{t("instructions.session.title")}</h3>
      <ul className="flex flex-col gap-1.5">
        {layers.map(({ scope, title, text }) => {
          if (scope === null) return null;
          const label =
            scope.kind === "profile"
              ? t("instructions.session.profile", { name: profileName(profile, t) })
              : scope.kind === "workspace"
                ? t("instructions.session.workspace", { name: workspace?.name })
                : scope.kind === "all"
                  ? t("instructions.all")
                  : title;
          return (
            <li key={title} className="flex items-center justify-between gap-2">
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
              <button
                type="button"
                className="shrink-0 cursor-pointer text-primary hover:underline"
                onClick={() => {
                  setOpen(false);
                  useSettingsUIStore.getState().openInstructions(scope);
                }}
              >
                {t(text ? "instructions.session.edit" : "instructions.session.add")}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <h4 className="text-app-body font-medium">{t("instructions.session.label")}</h4>
        <InstructionField
          label={t("instructions.session.label")}
          text={draft}
          onChange={setDraft}
        />
        {failed && (
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
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>
            {t("common:action.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void apply()}
            disabled={
              saving || draft === session || !InstructionTextSchema.safeParse(draft).success
            }
          >
            {t("instructions.session.apply")}
          </Button>
        </div>
        {preview && (
          <InstructionPreview
            text={mergeAgentInstructions(config, { ...target, session: draft })}
          />
        )}
        <p className="text-app-ui-sm text-muted-foreground">{t("instructions.session.applies")}</p>
      </div>
    </Popover>
  );
}
