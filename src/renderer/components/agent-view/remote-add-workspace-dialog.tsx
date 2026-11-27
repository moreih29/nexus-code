import { Eye, Folder, HardDrive, House } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import { slashWindowsPath } from "../../../shared/fs/relative-path";
import type { RoomPeer } from "../../../shared/remote/room";
import { ipcCallResult } from "../../ipc/client";
import { remoteDisplayName } from "../../services/remote/display-name";
import { peerRejoins, peerServes, refreshPeerSessions } from "../../services/remote/room";
import { selectPeerWorkspace } from "../../state/operations/workspace-selection";
import { peerTargetId, usePeerWorkspaceStore } from "../../state/stores/peer-workspace";
import { openRemoteSession } from "../../state/stores/remote-view";
import { useUIStore } from "../../state/stores/ui";
import { basename } from "../../utils/path";
import { joinPeerPath, peerPathKey } from "../../utils/peer-path";
import { peerTarget } from "../peer-workspace/room";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { RemoteNewMenu } from "./remote-new-menu";

type Listing = RpcResult<"folders.list">;
type FolderQuery = { path?: string; hidden: boolean };
type FolderAnswer = {
  query: FolderQuery;
  rejoins: number;
  listing?: Listing;
  error?: string;
};

export function RemoteAddWorkspaceDialog({
  peer,
  accountKey,
  online,
  served,
  onClose,
}: {
  peer: RoomPeer;
  accountKey: string;
  online: boolean;
  served: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState<FolderQuery>({ hidden: false });
  const [answer, setAnswer] = useState<FolderAnswer | null>(null);
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<{ key: string; detail: string } | null>(null);
  const [added, setAdded] = useState<RpcResult<"workspace.create"> | null>(null);
  const nameId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const { id: deviceId } = peer;
  const rejoins = peerRejoins(peer);
  const currentAnswer = answer?.query === query && answer.rejoins === rejoins ? answer : null;
  const listing = currentAnswer?.listing;
  const listError = currentAnswer?.error;
  const { path: here, hidden } = query;
  const enabled = online && served;
  const browsing = selected === undefined && added === null;

  useEffect(() => {
    if (!enabled || !browsing) return;
    const controller = new AbortController();
    void ipcCallResult(
      "remote",
      "peerFoldersList",
      { deviceId, ...query },
      { signal: controller.signal },
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        setAnswer({
          query,
          rejoins,
          ...(result.ok ? { listing: result.value } : { error: result.message }),
        });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setAnswer({ query, rejoins, error: String(error) });
      },
    );
    return () => controller.abort();
  }, [enabled, browsing, deviceId, query, rejoins]);

  useEffect(() => {
    if (selected !== undefined) nameInput.current?.focus();
  }, [selected]);

  const browse = (path: string | undefined) => setQuery({ path, hidden });

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const given = name.trim();
    if (!selected || !given || !enabled || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      const reply = await ipcCallResult("remote", "peerWorkspaceCreate", {
        deviceId,
        path: selected,
        name: given,
      });
      if (reply.ok) {
        refreshPeerSessions(deviceId);
        setAdded(reply.value);
      } else {
        setAddError({
          key: reply.kind === "permission-denied" ? "addRefused" : "addFailed",
          detail: reply.message,
        });
      }
    } catch (error) {
      setAddError({ key: "addFailed", detail: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const unavailable = !online
    ? t("agentView.remote.offlineTag")
    : !served
      ? t("agentView.remote.workspaceAdd.disabled")
      : null;
  const home = listing?.home;
  const path = listing?.path ?? here;
  const drives = listing && listing.parent === undefined ? (listing.roots ?? []) : [];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogHeader
        title={t("sidebar.add_workspace")}
        description={remoteDisplayName(peer.name)}
        close={!busy}
      />
      <div className="mt-4 flex flex-col gap-3 text-app-ui-sm">
        {unavailable && <p role="status">{unavailable}</p>}
        {added ? (
          <>
            <p role="status" className="text-muted-foreground">
              {t(
                added.created
                  ? "agentView.remote.workspaceAdd.added"
                  : "agentView.remote.workspaceAdd.exists",
              )}
            </p>
            <p className="break-all text-app-body-emphasis">{added.workspace.name}</p>
            <FolderPath path={added.workspace.path} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>
                {t("action.close")}
              </Button>
              {online && peerServes(peer, "chat.control") && (
                <RemoteNewMenu
                  peer={peer}
                  workspace={added.workspace}
                  chatsOnly
                  trigger={<Button size="sm">{t("chat.profile.newChat")}</Button>}
                  onOpenSession={(session) => {
                    onClose();
                    openRemoteSession(session);
                  }}
                />
              )}
              {online && peerServes(peer, "files") && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onClose();
                    const target = peerTarget(accountKey, peer, added.workspace);
                    selectPeerWorkspace(target);
                    usePeerWorkspaceStore.getState().setFilesMode(peerTargetId(target), "tree");
                    useUIStore.getState().setPanelHidden("files", false);
                  }}
                >
                  {t("agentView.remote.workspaceAdd.openFiles")}
                </Button>
              )}
            </div>
          </>
        ) : selected !== undefined ? (
          <form className="flex flex-col gap-3" onSubmit={(event) => void add(event)}>
            <FolderPath path={selected} />
            <label htmlFor={nameId}>{t("agentView.remote.workspaceAdd.name")}</label>
            <input
              ref={nameInput}
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              disabled={busy}
              className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {addError && (
              <FolderError
                message={t(`agentView.remote.workspaceAdd.${addError.key}`)}
                detail={addError.detail}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setSelected(undefined);
                  browse(here);
                }}
              >
                {t("action.back")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!enabled || !name.trim() || busy}
                loading={busy}
              >
                {t("sidebar.add_workspace")}
              </Button>
            </div>
          </form>
        ) : (
          <>
            {path && <FolderPath path={path} />}
            <div className="flex flex-wrap gap-1">
              {listing?.parent && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!enabled}
                  onClick={() => browse(listing.parent)}
                >
                  {t("sshPicker.go_to_parent")}
                </Button>
              )}
              {(home ? path !== home : here !== undefined) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!enabled}
                  onClick={() => browse(undefined)}
                >
                  <House aria-hidden />
                  {t("agentView.remote.workspaceAdd.home")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant={hidden ? "secondary" : "ghost"}
                aria-pressed={hidden}
                disabled={!enabled}
                onClick={() => setQuery({ path: here, hidden: !hidden })}
              >
                <Eye aria-hidden />
                {t("agentView.remote.workspaceAdd.showHidden")}
              </Button>
            </div>
            <div className="max-h-[40vh] overflow-y-auto rounded-(--radius-control) border border-border p-1">
              {listError && (
                <div className="space-y-2 p-2">
                  <FolderError
                    message={t("agentView.remote.workspaceAdd.listFailed")}
                    detail={listError}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!enabled}
                    onClick={() => browse(here)}
                  >
                    {t("action.retry")}
                  </Button>
                </div>
              )}
              {!listing && !listError && enabled && (
                <p role="status" className="p-2 text-muted-foreground">
                  {t("agentView.remote.loading")}
                </p>
              )}
              {listing && (
                <>
                  {drives
                    .filter((root) => peerPathKey(root) !== peerPathKey(listing.path))
                    .map((root) => (
                      <FolderRow
                        key={root}
                        label={root}
                        drive
                        disabled={!enabled}
                        onOpen={() => browse(root)}
                      />
                    ))}
                  {listing.entries.map(({ name }) => (
                    <FolderRow
                      key={name}
                      label={name}
                      disabled={!enabled}
                      onOpen={() => browse(joinPeerPath(listing.path, name))}
                    />
                  ))}
                  {listing.entries.length === 0 && (
                    <p role="status" className="p-2 text-muted-foreground">
                      {t("sshPicker.this_folder_empty")}
                    </p>
                  )}
                  {listing.truncated && (
                    <p role="status" className="p-2 text-muted-foreground">
                      {t("sshPicker.truncated")}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={!listing || !enabled}
                onClick={() => {
                  if (!listing) return;
                  setName(
                    (
                      basename(slashWindowsPath(listing.path).replace(/\/+$/, "")) || listing.path
                    ).slice(0, 200),
                  );
                  setSelected(listing.path);
                  setAddError(null);
                }}
              >
                {t("agentView.remote.workspaceAdd.choose")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function FolderRow({
  label,
  drive,
  disabled,
  onOpen,
}: {
  label: string;
  drive?: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const Icon = drive ? HardDrive : Folder;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-1 text-left hover:bg-[var(--state-hover-bg)] disabled:opacity-60"
      disabled={disabled}
      onClick={onOpen}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </button>
  );
}

function FolderPath({ path }: { path: string }) {
  return <p className="break-all font-mono text-app-micro text-muted-foreground">{path}</p>;
}

function FolderError({ message, detail }: { message: string; detail: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert">
      <p className="text-(--state-error-fg)">{message}</p>
      {detail && (
        <details className="text-app-micro text-muted-foreground">
          <summary className="cursor-pointer">{t("action.show_details")}</summary>
          <p className="break-all">{detail}</p>
        </details>
      )}
    </div>
  );
}
