import type { RpcMethod, RpcRequest } from "../../../../../packages/remote-protocol/src";
import type { SystemStats } from "../../../../shared/system/stats";
import type { AgentGate } from "../agent-gate";
import type { Attachments } from "../attachments";
import type { ChatWatches } from "../chat-watches";
import type { ConsentControls } from "../consents";
import type { FileWrites } from "../file-writes";
import type { RemoteFiles } from "../files";
import type { FolderSystem } from "../folders";
import type { RemoteGit } from "../git";
import type { PhotoQuota, RemoteNotes } from "../notes";
import type { SessionWatches } from "../session-watches";
import type { TerminalWatches } from "../terminal-watches";
import type { Uploads } from "../uploads";

export interface RemoteServeOptions {
  chats?: ChatWatches;
  sessions?: SessionWatches;
  terminals?: TerminalWatches;
  git?: WorkspaceGit;
  attachments?: Attachments;
  uploads?: Uploads;
  fileWrites?: FileWrites;
  files?: Omit<RemoteFiles, "folders">;
  repositories?: RemoteGit;
  stats?: (workspaceId: string) => Promise<SystemStats | null>;
  notes?: RemoteNotes;
  photoQuota?: PhotoQuota;
  agents?: AgentGate;
  deviceName?: (id: string) => string | undefined;
  folders?: FolderSystem;
  controls?: () => ConsentControls;
}

export interface RemoteServeRequest {
  from: string;
  id?: RpcRequest["id"];
  method: RpcMethod;
  params: unknown;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  waits?: boolean;
}

import type { WorkspaceGit } from "./sessions";
