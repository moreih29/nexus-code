import { describe, expect, test } from "bun:test";

import type { TerminalServiceStore, TerminalTabId } from "../../services/terminal-service";
import { attachTerminalPaneAdapterHost } from "./TerminalPaneAdapter";

describe("TerminalPaneAdapter", () => {
  test("attaches the terminal session to a host and detaches that host on cleanup", () => {
    const sessionId = "tt_ws_alpha_0001" as TerminalTabId;
    const host = {} as HTMLElement;
    const service = createTerminalServiceSpy();

    const cleanup = attachTerminalPaneAdapterHost({
      sessionId,
      host,
      terminalService: service.store,
    });

    expect(service.attachCalls).toEqual([{ sessionId, host }]);
    expect(service.getMountedHost(sessionId)).toBe(host);

    cleanup();
    cleanup();

    expect(service.detachCalls).toEqual([sessionId]);
    expect(service.getMountedHost(sessionId)).toBeNull();
  });

  test("does not detach a newer host for the same session", () => {
    const sessionId = "tt_ws_alpha_0002" as TerminalTabId;
    const firstHost = { id: "first" } as unknown as HTMLElement;
    const secondHost = { id: "second" } as unknown as HTMLElement;
    const service = createTerminalServiceSpy();

    const cleanup = attachTerminalPaneAdapterHost({
      sessionId,
      host: firstHost,
      terminalService: service.store,
    });
    service.attachToHost(sessionId, secondHost);

    cleanup();

    expect(service.detachCalls).toEqual([]);
    expect(service.getMountedHost(sessionId)).toBe(secondHost);
  });
});

function createTerminalServiceSpy(): {
  store: TerminalServiceStore;
  attachCalls: Array<{ sessionId: TerminalTabId; host: HTMLElement }>;
  detachCalls: TerminalTabId[];
  attachToHost(sessionId: TerminalTabId, host: HTMLElement): () => void;
  getMountedHost(sessionId: TerminalTabId): HTMLElement | null;
} {
  const attachCalls: Array<{ sessionId: TerminalTabId; host: HTMLElement }> = [];
  const detachCalls: TerminalTabId[] = [];
  const mountedHostBySessionId = new Map<TerminalTabId, HTMLElement>();

  const attachToHost = (sessionId: TerminalTabId, host: HTMLElement): (() => void) => {
    attachCalls.push({ sessionId, host });
    mountedHostBySessionId.set(sessionId, host);

    return () => {
      if (mountedHostBySessionId.get(sessionId) === host) {
        mountedHostBySessionId.delete(sessionId);
      }
    };
  };
  const detachFromHost = (sessionId: TerminalTabId): void => {
    detachCalls.push(sessionId);
    mountedHostBySessionId.delete(sessionId);
  };
  const getMountedHost = (sessionId: TerminalTabId): HTMLElement | null => {
    return mountedHostBySessionId.get(sessionId) ?? null;
  };

  return {
    store: {
      getState: () => ({
        attachToHost,
        detachFromHost,
        getMountedHost,
      }),
    } as unknown as TerminalServiceStore,
    attachCalls,
    detachCalls,
    attachToHost,
    getMountedHost,
  };
}
