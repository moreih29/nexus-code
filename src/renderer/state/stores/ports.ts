// The TCP ports the programs in each workspace's terminals listen on,
// mirrored from main (pty:ports). The status bar and the task switcher show
// them.

import { create } from "zustand";
import type { ListeningPort, WorkspacePorts } from "../../../shared/pty/ports";

/** A stable empty list, so a workspace without ports keeps its selection. */
export const NO_PORTS: readonly ListeningPort[] = [];

interface PortsState {
  byWorkspace: Record<string, readonly ListeningPort[]>;
  /**
   * The workspaces a change has come for: main's ports at launch, asked
   * before it came, are older for them.
   */
  changed: Record<string, true>;
  /** Main's ports at launch, for the workspaces no change has come for since. */
  hydrate(entries: WorkspacePorts[]): void;
  set(entry: WorkspacePorts): void;
}

export const usePortsStore = create<PortsState>((set) => ({
  byWorkspace: {},
  changed: {},

  hydrate(entries) {
    set((s) => ({
      byWorkspace: {
        ...Object.fromEntries(
          entries
            .filter((entry) => !s.changed[entry.workspaceId])
            .map((entry) => [entry.workspaceId, entry.ports]),
        ),
        ...s.byWorkspace,
      },
    }));
  },

  set({ workspaceId, ports }) {
    set((s) => {
      const changed: Record<string, true> = s.changed[workspaceId]
        ? s.changed
        : { ...s.changed, [workspaceId]: true };
      if (ports.length > 0) {
        return { byWorkspace: { ...s.byWorkspace, [workspaceId]: ports }, changed };
      }
      const { [workspaceId]: _stopped, ...rest } = s.byWorkspace;
      return { byWorkspace: workspaceId in s.byWorkspace ? rest : s.byWorkspace, changed };
    });
  },
}));
