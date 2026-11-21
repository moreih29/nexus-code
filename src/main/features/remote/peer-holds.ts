/**
 * What another device holds open here while its connection lasts: the
 * chats, terminals and sessions' list it watches, and the files it writes.
 * A device the room shows gone, or one heard in a new connection while the
 * room still showed it there (RemoteRoom's onDisconnect with its id), holds
 * none of it any more: what it still wants to watch it asks for again in
 * its new connection. This device leaving the room, or starting a new
 * connection of its own (onDisconnect with no id), ends what every device
 * held.
 */
import type { ChatWatches } from "./chat-watches";
import type { FileWrites } from "./file-writes";
import type { SessionWatches } from "./session-watches";
import type { TerminalWatches } from "./terminal-watches";

export interface PeerHolds {
  chats: Pick<ChatWatches, "dropDevice" | "dropAll">;
  sessions: Pick<SessionWatches, "dropDevice" | "dropAll">;
  terminals: Pick<TerminalWatches, "dropDevice" | "dropAll">;
  fileWrites: Pick<FileWrites, "drop">;
}

/**
 * Ends what `peer` held here, or what every device held when none is given.
 * Each kind ends only the watches open now, so one the device asks for
 * after this, in its new connection, stays.
 */
export function dropPeerHolds(holds: PeerHolds, peer?: string): void {
  void holds.fileWrites.drop(peer);
  if (peer === undefined) {
    void holds.chats.dropAll();
    holds.sessions.dropAll();
    void holds.terminals.dropAll();
    return;
  }
  void holds.chats.dropDevice(peer);
  holds.sessions.dropDevice(peer);
  void holds.terminals.dropDevice(peer);
}
