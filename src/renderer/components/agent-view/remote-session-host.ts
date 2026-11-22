import { createContext } from "react";
import type { OpenRemoteSession } from "../../state/stores/remote-view";
import type { FileLookOptions } from "../chat/file-look";

export type OpenRemoteFileBeside = (path: string, options: FileLookOptions) => boolean;

/** Placement and tab actions when the session pane is hosted outside the agent view. */
export interface RemoteSessionHost {
  focusKey: string;
  openSession: OpenRemoteSession;
  openFileBeside: OpenRemoteFileBeside;
  hideSession(): void;
  onGone(): void;
}

export const RemoteSessionHostContext = createContext<RemoteSessionHost | null>(null);
