/**
 * The + in the heading of another computer's workspace, in the agent
 * view's list: a new Claude or Codex conversation there, where that
 * computer lets this one control its chats, and a new terminal, where it
 * lets this one control its terminals; shown in a panel once it opens, as
 * a click on its row shows it. As the tab bar's + has it: with more than
 * one profile of an agent there, a submenu opens a conversation with
 * another than the workspace's; with more than one shell, the terminal
 * asks which. The profiles and shells are asked as the menu opens (or the
 * pointer comes to it), and kept for the next time.
 */

import { Plus, SquareTerminal } from "lucide-react";
import { useState } from "react";
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

/** Each computer's profiles, as it last listed them. */
const knownProfiles = new Map<string, readonly PeerProfile[]>();
/** Each workspace's shells, by computer and workspace, as last listed. */
const knownShells = new Map<string, readonly PeerShell[]>();

export function RemoteNewMenu({
  peer,
  workspace,
  onOpenSession,
}: {
  peer: RoomPeer;
  workspace: { id: string; name: string; path: string };
  onOpenSession?: OpenRemoteSession;
}) {
  const { t } = useTranslation();
  const chats = peerServes(peer, "chat.control");
  const terminals = peerServes(peer, "terminal.control");
  const shellsKey = `${peer.id}/${workspace.id}`;
  const [profiles, setProfiles] = useState(() => knownProfiles.get(peer.id) ?? null);
  const [shells, setShells] = useState(() => knownShells.get(shellsKey) ?? null);
  if (!chats && !terminals) return null;

  const load = () => {
    if (chats) {
      void ipcCallResult("remote", "peerProfiles", { deviceId: peer.id }).then((result) => {
        // Not listed: those known before, if any; the workspace's own profile opens either way.
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
        // Not listed: the computer's default shell, as with none named.
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

  return (
    <DropdownMenuRoot
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger>
        <IconButton
          label={t("agentView.remote.newIn", { name: workspace.name })}
          size="xs"
          // Asked before the click, so the menu opens with them where it can.
          onPointerEnter={() => {
            if ((chats && profiles === null) || (terminals && shells === null)) load();
          }}
          data-testid="remote-new-menu"
        >
          <Plus aria-hidden className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {chats &&
          (["claude", "codex"] as const).map((agent) => (
            <NewChatItems
              key={agent}
              agent={agent}
              profiles={(profiles ?? []).filter((p) => p.agent === agent)}
              onOpen={(profile) => void newPeerChat(where, agent, profile, onOpenSession)}
            />
          ))}
        {terminals && (
          <NewTerminalItems
            shells={shells}
            onOpen={(shell) => void newPeerTerminal(where, shell, onOpenSession)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * A new conversation of `agent`: with the profile the workspace gives, and,
 * with more than one there, a submenu of them all, as the tab bar's items.
 */
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

/**
 * A new terminal: with more than one shell there, a submenu asks which, its
 * default one marked; with one or none listed, its default. Until the
 * computer has said, it waits.
 */
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
