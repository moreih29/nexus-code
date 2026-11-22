import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_FIND_RESULTS, type RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import { subscribePeerQuickOpen } from "../../services/remote/peer-quick-open";
import type { PeerReach } from "../../services/remote/room";
import { type PeerWorkspaceTarget, peerTargetId } from "../../state/stores/peer-workspace";
import { basename } from "../../utils/path";
import { peerSearchResultPath } from "../../utils/peer-path";
import { CommandPalette } from "../ui/palette/command-palette";
import type { PaletteItem, PaletteSource } from "../ui/palette/types";
import { markMissingPeer, openPeerResult, peerSearchErrorKey } from "./search-model";

const FIND_QUERY_LIMIT = 256;

interface PeerFileItem extends PaletteItem {
  path: string;
}

class PeerQuickOpenError extends Error {}

export function createPeerQuickOpenSource({
  t,
  target,
  canRead,
  blocked,
}: {
  t: TFunction;
  target: PeerWorkspaceTarget;
  canRead: boolean;
  blocked: string | null;
}): PaletteSource<PeerFileItem> {
  return {
    id: peerTargetId(target),
    title: t("peerWorkspace.quickOpen"),
    placeholder: t("peerWorkspace.quickOpenPlaceholder"),
    emptyQueryMessage: blocked ?? t("peerWorkspace.quickOpenPrompt"),
    noResultsMessage: t("peerWorkspace.quickOpenEmpty"),
    maxQueryLength: FIND_QUERY_LIMIT,
    errorMessage: (error) => (error instanceof PeerQuickOpenError ? error.message : undefined),
    async search(query, signal) {
      const text = query.trim().slice(0, FIND_QUERY_LIMIT);
      if (!text) return [];
      if (blocked || !canRead) {
        throw new PeerQuickOpenError(blocked ?? t("peerWorkspace.connectionUnavailable"));
      }
      signal.throwIfAborted();
      let reply: IpcResult<RpcResult<"files.find">>;
      try {
        reply = await ipcCallResult(
          "remote",
          "peerFilesFind",
          {
            deviceId: target.deviceId,
            workspaceId: target.workspaceId,
            query: text,
            limit: MAX_FIND_RESULTS,
          },
          { signal },
        );
      } catch {
        signal.throwIfAborted();
        throw new PeerQuickOpenError(t("peerWorkspace.connectionUnavailable"));
      }
      signal.throwIfAborted();
      if (!reply.ok) {
        if (reply.kind === "not-found") {
          markMissingPeer(target);
          throw new PeerQuickOpenError(t("peerWorkspace.missingWorkspace"));
        }
        throw new PeerQuickOpenError(t(peerSearchErrorKey(reply.kind)));
      }
      return reply.value.files
        .slice(0, MAX_FIND_RESULTS)
        .flatMap((path, index) =>
          peerSearchResultPath(target.workspace.path, path) === null
            ? []
            : [{ id: String(index), path, label: basename(path), detail: path }],
        );
    },
    accept(item) {
      if (canRead && !blocked) openPeerResult(target, item.path, true);
    },
  };
}

export function PeerQuickOpen({
  target,
  reach,
  canRead,
  missing,
  updateNeeded,
}: {
  target: PeerWorkspaceTarget;
  reach: PeerReach;
  canRead: boolean;
  missing: boolean;
  updateNeeded: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const id = peerTargetId(target);
  useEffect(
    () =>
      subscribePeerQuickOpen((selected) => {
        if (selected === id) setOpen(true);
      }),
    [id],
  );

  const blocked = missing
    ? t("peerWorkspace.missingWorkspace")
    : updateNeeded
      ? t("peerWorkspace.updateNeeded")
      : reach === "offline"
        ? t("peerWorkspace.offlineLast", { device: target.deviceName })
        : reach === "disconnected"
          ? t("peerWorkspace.disconnectedLast")
          : null;
  const source = useMemo(
    () => createPeerQuickOpenSource({ t, target, canRead, blocked }),
    [blocked, canRead, t, target],
  );
  return <CommandPalette open={open} source={source} onClose={close} />;
}
