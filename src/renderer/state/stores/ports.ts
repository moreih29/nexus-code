import { create } from "zustand";
import type {
  ListeningPort,
  PortForward,
  WorkspaceForwards,
  WorkspacePorts,
} from "../../../shared/pty/ports";

export const NO_PORTS: readonly ListeningPort[] = [];

interface PortsState {
  byWorkspace: Record<string, readonly ListeningPort[]>;
  changed: Record<string, true>;
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

export const NO_FORWARDS: readonly PortForward[] = [];

interface ForwardsState {
  byWorkspace: Record<string, readonly PortForward[]>;
  changed: Record<string, true>;
  hydrate(entries: WorkspaceForwards[]): void;
  set(entry: WorkspaceForwards): void;
}

export const useForwardsStore = create<ForwardsState>((set) => ({
  byWorkspace: {},
  changed: {},

  hydrate(entries) {
    set((s) => ({
      byWorkspace: {
        ...Object.fromEntries(
          entries
            .filter((entry) => !s.changed[entry.workspaceId])
            .map((entry) => [entry.workspaceId, entry.forwards]),
        ),
        ...s.byWorkspace,
      },
    }));
  },

  set({ workspaceId, forwards }) {
    set((s) => {
      const changed: Record<string, true> = { ...s.changed, [workspaceId]: true };
      if (forwards.length > 0) {
        return { byWorkspace: { ...s.byWorkspace, [workspaceId]: forwards }, changed };
      }
      const { [workspaceId]: _stopped, ...rest } = s.byWorkspace;
      return { byWorkspace: rest, changed };
    });
  },
}));
