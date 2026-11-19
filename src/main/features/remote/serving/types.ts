import type { RpcMethod } from "../../../../../packages/remote-protocol/src";
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

/** Optional services available to the remote request router. */
export interface RemoteServeOptions {
  chats?: ChatWatches;
  sessions?: SessionWatches;
  terminals?: TerminalWatches;
  /** The tasks' git facts the sessions' list tells. */
  git?: WorkspaceGit;
  /** The images and files devices attached for their next messages. */
  attachments?: Attachments;
  /** The files devices are sending a piece at a time; fresh ones when not given. */
  uploads?: Uploads;
  fileWrites?: FileWrites;
  /** The workspaces' file systems, and how an image is drawn smaller. */
  files?: Omit<RemoteFiles, "folders">;
  /** The workspaces' repositories, for git.status, git.diff, git.log and git.show. */
  repositories?: RemoteGit;
  /** The workspaces' notes, for notes.list and notes.attach, and the note it records into. */
  notes?: RemoteNotes;
  /** How many photos each device put into notes lately; a fresh one when not given. */
  photoQuota?: PhotoQuota;
  /** Whether an agent on another device may do what it asks (a request with `from`). */
  agents?: AgentGate;
  /** A device of the room by its id, as it names itself. */
  deviceName?: (id: string) => string | undefined;
  /** The folders folders.list goes through; the system's when not given. */
  folders?: FolderSystem;
  /**
   * What the user lets other devices control here, for the consent prompts
   * they may answer; none when not told.
   */
  controls?: () => ConsentControls;
}

/** The method, parameters and lifetime of a request from another device. */
export interface RemoteServeRequest {
  from: string;
  method: RpcMethod;
  params: unknown;
  isCurrent?: () => boolean;
}

import type { WorkspaceGit } from "./sessions";
