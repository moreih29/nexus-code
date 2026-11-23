/**
 * The instructions chip of another computer's chat, as a chat here shows
 * its own: that computer's layers are only shown, its session layer is set
 * from here where it lets this one control its chats. A computer before
 * protocol 0.16.0 tells only the combined text, which is only shown.
 */

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { mergeInstructionLayers } from "../../../shared/chat/instructions";
import {
  type PeerInstructionsRead,
  type PeerInstructionsState,
  usePeerInstructions,
} from "../../services/remote/peer-instructions";
import type { PeerChatRef } from "../../services/remote/peer-mcp";
import {
  type InstructionRow,
  type InstructionsChipSlot,
  InstructionsChipView,
} from "../chat/session-instructions-chip";

/** The session layer's title, as the serving app writes it in the combined text. */
const SESSION_TITLE = "This session";

type Layer = NonNullable<PeerInstructionsRead["layers"]>[number];

/** What a layer's title names after its kind, as the serving app writes it ("Profile: work"). */
function nameIn(title: string, prefix: string): string | undefined {
  return title.startsWith(prefix) ? title.slice(prefix.length) : undefined;
}

export function remoteInstructionRows(
  layers: readonly Layer[],
  t: TFunction<["settings", "common"]>,
  names: { profile?: string; workspace: string },
): InstructionRow[] {
  return layers.map(({ scope, title, text }) => {
    const label =
      scope.kind === "profile"
        ? t("instructions.session.profile", {
            name: nameIn(title, "Profile: ") ?? names.profile ?? scope.id,
          })
        : scope.kind === "workspace"
          ? t("instructions.session.workspace", {
              name: nameIn(title, "Workspace: ") ?? names.workspace,
            })
          : scope.kind === "all"
            ? t("instructions.all")
            : title;
    const id = scope.kind === "profile" || scope.kind === "workspace" ? `:${scope.id}` : "";
    return { key: `${scope.kind}${id}`, label, text };
  });
}

export interface RemoteInstructionsChipViewProps extends InstructionsChipSlot {
  state: PeerInstructionsState;
  deviceName: string;
  profile?: string;
  workspaceName: string;
  /** That computer lets this one control its chats (chat.control). */
  controls: boolean;
  refresh: () => void;
  save: (text: string) => Promise<void>;
}

export function RemoteInstructionsChipView({
  state,
  deviceName,
  profile,
  workspaceName,
  controls,
  refresh,
  save,
  ...slot
}: RemoteInstructionsChipViewProps) {
  const { t } = useTranslation(["settings", "common"]);
  if (state.status !== "ready") {
    return (
      <InstructionsChipView
        {...slot}
        loading={state.status === "loading"}
        failed={state.status === "failed"}
        onRetry={refresh}
        onOpen={refresh}
        rows={[]}
        session={undefined}
        combined={() => ""}
      />
    );
  }
  const { instructions, session, layers } = state.value;
  const viewOnly = t("common:agentView.remote.viewOnlyNote", { device: deviceName });
  // An older computer: no layers or session apart, so nothing to set.
  if (session === undefined || layers === undefined) {
    return (
      <InstructionsChipView
        {...slot}
        onOpen={refresh}
        rows={[]}
        session={undefined}
        combined={() => instructions}
        note={controls ? t("instructions.session.remoteUpdate", { device: deviceName }) : viewOnly}
      />
    );
  }
  return (
    <InstructionsChipView
      {...slot}
      onOpen={refresh}
      rows={remoteInstructionRows(layers, t, { profile, workspace: workspaceName })}
      rowsNote={t("instructions.session.remoteLayers", { device: deviceName })}
      session={session}
      {...(controls ? { save } : { note: viewOnly })}
      combined={(draft) =>
        mergeInstructionLayers([...layers, { title: SESSION_TITLE, text: draft.trim() }])
      }
    />
  );
}

/** The chip, reading the chat's instructions while that computer serves chat.read. */
export function RemoteInstructionsChip({
  chat,
  deviceName,
  profile,
  workspaceName,
  controls,
  ...slot
}: InstructionsChipSlot & {
  chat: PeerChatRef;
  deviceName: string;
  profile?: string;
  workspaceName: string;
  controls: boolean;
}) {
  const { state, refresh, save } = usePeerInstructions(chat);
  return (
    <RemoteInstructionsChipView
      {...slot}
      state={state}
      deviceName={deviceName}
      {...(profile ? { profile } : {})}
      workspaceName={workspaceName}
      controls={controls}
      refresh={refresh}
      save={save}
    />
  );
}
