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
