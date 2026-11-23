import { Plus, SquareTerminal } from "lucide-react";
import { cloneElement, type ReactElement, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import { ipcCallResult } from "../../ipc/client";
import { peerServes } from "../../services/remote/room";
import type { OpenRemoteSession } from "../../state/stores/remote-view";
import { ProfileDot } from "../agent-profiles/profile-badge";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { peerProfileName } from "./remote-profile-chip";
import { newPeerChat, newPeerTerminal, type PeerWorkspaceRef } from "./remote-session-actions";

export type PeerProfile = RpcResult<"profiles.list">["profiles"][number];
export type PeerShell = RpcResult<"terminal.shells">["shells"][number];

const knownProfiles = new Map<string, readonly PeerProfile[]>();
const knownShells = new Map<string, readonly PeerShell[]>();

export function RemoteNewMenu({
  peer,
  workspace,
  onOpenSession,
  trigger,
  chatsOnly = false,
  terminalFirst = false,
  children,
}: {
  peer: RoomPeer;
  workspace: { id: string; name: string; path: string };
  onOpenSession?: OpenRemoteSession;
  trigger?: ReactElement<{ onPointerEnter?: () => void }>;
  chatsOnly?: boolean;
  terminalFirst?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const chats = peerServes(peer, "chat.control");
  const terminals = !chatsOnly && peerServes(peer, "terminal.control");
  const shellsKey = `${peer.id}/${workspace.id}`;
  const [profiles, setProfiles] = useState(() => knownProfiles.get(peer.id) ?? null);
  const [shells, setShells] = useState(() => knownShells.get(shellsKey) ?? null);
  if (!chats && !terminals && !children) return null;

  const load = () => {
    if (chats) {
      void ipcCallResult("remote", "peerProfiles", { deviceId: peer.id }).then((result) => {
        if (!result.ok) return;
        knownProfiles.set(peer.id, result.value.profiles);
        setProfiles(result.value.profiles);
      });
    }
    if (terminals) {
      void ipcCallResult("remote", "peerTerminalShells", {
        deviceId: peer.id,
        workspaceId: workspace.id,
      }).then((result) => {
        const listed = result.ok ? result.value.shells : (knownShells.get(shellsKey) ?? []);
        knownShells.set(shellsKey, listed);
        setShells(listed);
      });
    }
  };
  const where: PeerWorkspaceRef = {
    deviceId: peer.id,
    deviceName: peer.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    path: workspace.path,
  };

  const preload = () => {
    if ((chats && profiles === null) || (terminals && shells === null)) load();
  };
  const terminalItems = (
    <NewTerminalItems
      shells={shells}
      onOpen={(shell) => void newPeerTerminal(where, shell, onOpenSession)}
    />
  );

  return (
    <DropdownMenuRoot
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger>
        {trigger ? (
          cloneElement(trigger, { onPointerEnter: preload })
        ) : (
          <IconButton
            label={t("agentView.remote.newIn", { name: workspace.name })}
            size="xs"
            onPointerEnter={preload}
            data-testid="remote-new-menu"
          >
            <Plus aria-hidden className="size-3.5" />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {terminals && terminalFirst && terminalItems}
        {chats &&
          (["claude", "codex"] as const).map((agent) => (
            <NewChatItems
              key={agent}
              agent={agent}
              profiles={(profiles ?? []).filter((p) => p.agent === agent)}
              onOpen={(profile) => void newPeerChat(where, agent, profile, onOpenSession)}
            />
          ))}
        {terminals && !terminalFirst && terminalItems}
        {children}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function NewChatItems({
  agent,
  profiles,
  onOpen,
}: {
  agent: "claude" | "codex";
  profiles: readonly PeerProfile[];
  onOpen: (profile?: PeerProfile) => void;
}) {
  const { t } = useTranslation();
  const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
  return (
    <>
      <DropdownMenuItem onSelect={() => onOpen()}>
        <Icon aria-hidden className="mr-1.5 size-3.5 shrink-0" />
        <span className="flex-1">
          {t(agent === "claude" ? "tabBar.new_claude" : "tabBar.new_codex")}
        </span>
      </DropdownMenuItem>
      {profiles.length > 1 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon aria-hidden className="mr-1.5 size-3.5 shrink-0" />
            <span className="flex-1">
              {t(agent === "claude" ? "tabBar.new_claude_with" : "tabBar.new_codex_with")}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {profiles.map((profile) => (
              <DropdownMenuItem key={profile.id} onSelect={() => onOpen(profile)}>
                <span className="flex flex-1 items-center gap-2">
                  <ProfileDot color="gray" />
                  {peerProfileName(profile.name, t)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </>
  );
}

function NewTerminalItems({
  shells,
  onOpen,
}: {
  shells: readonly PeerShell[] | null;
  onOpen: (shell?: PeerShell) => void;
}) {
  const { t } = useTranslation();
  const label = (
    <>
      <SquareTerminal aria-hidden className="mr-1.5 size-3.5 shrink-0" />
      <span className="flex-1">{t("tabBar.new_terminal")}</span>
    </>
  );
  if (shells === null || shells.length <= 1) {
    return (
      <DropdownMenuItem disabled={shells === null} onSelect={() => onOpen(shells?.[0])}>
        {label}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {shells.map((shell) => (
          <DropdownMenuItem key={shell.id} onSelect={() => onOpen(shell)}>
            <span className="flex-1">{shell.name}</span>
            {shell.isDefault && (
              <span className="ml-4 text-muted-foreground">{t("tabBar.default_shell")}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
