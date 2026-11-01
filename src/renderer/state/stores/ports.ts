// The TCP ports the programs in each workspace's terminals listen on,
// mirrored from main (pty:ports). The status bar and the task switcher show
// them.

import { create } from "zustand";
import type { ListeningPort, WorkspacePorts } from "../../../shared/pty/ports";

/** A stable empty list, so a workspace without ports keeps its selection. */
export const NO_PORTS: readonly ListeningPort[] = [];

interface PortsState {
  byWorkspace: Record<string, readonly ListeningPort[]>;
  /** Main's ports at launch; a change broadcast since stays. */
  hydrate(entries: WorkspacePorts[]): void;
  set(entry: WorkspacePorts): void;
}

export const usePortsStore = create<PortsState>((set) => ({
  byWorkspace: {},

  hydrate(entries) {
    set((s) => ({
      byWorkspace: {
        ...Object.fromEntries(entries.map((entry) => [entry.workspaceId, entry.ports])),
        ...s.byWorkspace,
      },
    }));
  },

  set({ workspaceId, ports }) {
    set((s) => {
      if (ports.length > 0) return { byWorkspace: { ...s.byWorkspace, [workspaceId]: ports } };
      if (!(workspaceId in s.byWorkspace)) return s;
      const { [workspaceId]: _stopped, ...rest } = s.byWorkspace;
      return { byWorkspace: rest };
    });
  },
}));
