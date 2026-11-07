import { describe, expect, test } from "bun:test";
import {
  ForwardError,
  PortForwards,
  type SavedForward,
} from "../../../../src/main/features/pty/forwards";
import type {
  SshForwarding,
  SshForwardTarget,
  SshTunnel,
} from "../../../../src/main/infra/agent/ssh/forward";
import type { WorkspaceForwards } from "../../../../src/shared/pty/ports";

const WS = "ws";

interface FakeTunnel extends SshTunnel {
  /** Ends it as an ssh of its own that exited would. */
  end(): void;
}

/** A PortForwards over a fake connection and fake tunnels. */
function setup(
  options: { taken?: number[]; failWith?: string; saved?: Record<string, SavedForward[]> } = {},
) {
  const saves: Array<[string, SavedForward[]]> = [];
  const taken = new Set(options.taken ?? []);
  const ssh: { current: SshForwarding | null } = {
    current: { host: "devbox", connecting: false, target: { host: "devbox", controlPath: "/c1" } },
  };
  const opened: Array<{ target: SshForwardTarget; localPort: number; remotePort: number }> = [];
  const tunnels: FakeTunnel[] = [];
  const broadcasts: WorkspaceForwards[] = [];
  const forwards = new PortForwards({
    ssh: () => ssh.current,
    broadcast: (entry) => broadcasts.push(entry),
    pickPort: async (preferred) => {
      let port = preferred;
      while (taken.has(port)) port += 1;
      return port;
    },
    openTunnel: async (target, localPort, remotePort) => {
      if (options.failWith) throw new Error(options.failWith);
      opened.push({ target, localPort, remotePort });
      let alive = true;
      let settle = () => {};
      const closed = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const tunnel: FakeTunnel = {
        localPort,
        remotePort,
        controlPath: target.controlPath,
        alive: () => alive,
        closed,
        async close() {
          alive = false;
          settle();
        },
        end() {
          alive = false;
          settle();
        },
      };
      tunnels.push(tunnel);
      return tunnel;
    },
    connectTimeoutMs: 50,
    saved: options.saved,
    save: (workspaceId, list) => saves.push([workspaceId, list]),
  });
  return { forwards, ssh, opened, tunnels, broadcasts, taken, saves };
}

describe("PortForwards", () => {
  test("forwards a port on the same number here when it is free, and once", async () => {
    const { forwards, opened, broadcasts } = setup();
    expect(await forwards.forward(WS, 5173)).toEqual({
      remotePort: 5173,
      localPort: 5173,
      active: true,
    });
    await forwards.forward(WS, 5173);
    expect(opened).toHaveLength(1);
    expect(broadcasts.at(-1)).toEqual({
      workspaceId: WS,
      forwards: [{ remotePort: 5173, localPort: 5173, active: true }],
    });
  });

  test("takes another port here when the host's is taken", async () => {
    const { forwards } = setup({ taken: [5173] });
    expect((await forwards.forward(WS, 5173)).localPort).toBe(5174);
  });

  test("a workspace on this machine has nothing to forward", async () => {
    const { forwards, ssh } = setup();
    ssh.current = null;
    await expect(forwards.forward(WS, 5173)).rejects.toMatchObject({ kind: "not-ssh" });
    expect(forwards.rewrites(WS, "http://localhost:5173/")).toBe(false);
  });

  test("a workspace not connected cannot forward; one connecting is waited for", async () => {
    const { forwards, ssh } = setup();
    ssh.current = { host: "devbox", connecting: false, target: null };
    await expect(forwards.forward(WS, 5173)).rejects.toThrow(
      new ForwardError("not-connected", "devbox is not connected"),
    );

    ssh.current = { host: "devbox", connecting: true, target: null };
    const waiting = forwards.forward(WS, 5173);
    ssh.current = { host: "devbox", connecting: false, target: { host: "devbox" } };
    forwards.connectionChanged(WS, "connected");
    expect((await waiting).active).toBe(true);
  });

  test("a forward that fails is not kept, and says why", async () => {
    const { forwards, broadcasts } = setup({ failWith: "Port forwarding failed" });
    const failure = await forwards.forward(WS, 5173).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: "failed",
      message: "could not forward port 5173: Port forwarding failed",
      reason: "Port forwarding failed",
    });
    expect(forwards.list(WS)).toEqual([]);
    expect(broadcasts.at(-1)).toEqual({ workspaceId: WS, forwards: [] });
  });

  test("a local address opens on its forward; other URLs and the forward's own end are as given", async () => {
    const { forwards, opened } = setup({ taken: [5173] });
    expect(await forwards.localUrl(WS, "http://localhost:5173/login?x=1")).toBe(
      "http://localhost:5174/login?x=1",
    );
    expect(await forwards.localUrl(WS, "http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5174/");
    expect(await forwards.localUrl(WS, "https://example.com/")).toBe("https://example.com/");
    // A page on the forward's local end, reloaded, stays there.
    expect(forwards.rewrites(WS, "http://localhost:5174/")).toBe(false);
    expect(opened).toHaveLength(1);
  });

  test("stopping a forward closes it", async () => {
    const { forwards, tunnels, broadcasts } = setup();
    await forwards.forward(WS, 3000);
    await forwards.stop(WS, 3000);
    expect(tunnels[0].alive()).toBe(false);
    expect(forwards.list(WS)).toEqual([]);
    expect(broadcasts.at(-1)).toEqual({ workspaceId: WS, forwards: [] });
  });

  test("a drop closes the forwards; reconnecting sets them up again on the same ports here", async () => {
    const { forwards, ssh, opened, tunnels } = setup({ taken: [5173] });
    await forwards.forward(WS, 5173);
    forwards.connectionChanged(WS, "disconnected");
    expect(tunnels[0].alive()).toBe(false);
    expect(forwards.list(WS)).toEqual([{ remotePort: 5173, localPort: 5174, active: false }]);

    // A new ControlMaster has none of the old one's forwards.
    ssh.current = {
      host: "devbox",
      connecting: false,
      target: { host: "devbox", controlPath: "/c2" },
    };
    forwards.connectionChanged(WS, "connected");
    await Bun.sleep(0);
    expect(opened.at(-1)).toMatchObject({ localPort: 5174, remotePort: 5173 });
    expect(opened.at(-1)?.target.controlPath).toBe("/c2");
    expect(forwards.list(WS)).toEqual([{ remotePort: 5173, localPort: 5174, active: true }]);
  });

  test("a connection that comes back on the same master keeps its forwards", async () => {
    const { forwards, opened } = setup();
    await forwards.forward(WS, 5173);
    forwards.connectionChanged(WS, "reconnecting");
    forwards.connectionChanged(WS, "connected");
    await Bun.sleep(0);
    expect(opened).toHaveLength(1);
  });

  test("an ssh of its own that exits leaves its forward inactive, set up again when asked", async () => {
    const { forwards, tunnels, opened } = setup();
    await forwards.forward(WS, 8080);
    tunnels[0].end();
    await Bun.sleep(0);
    expect(forwards.list(WS)).toEqual([{ remotePort: 8080, localPort: 8080, active: false }]);
    expect((await forwards.forward(WS, 8080)).active).toBe(true);
    expect(opened).toHaveLength(2);
  });

  test("a removed workspace's forwards close and are forgotten", async () => {
    const { forwards, tunnels } = setup();
    await forwards.forward(WS, 5173);
    forwards.removed(WS);
    expect(tunnels[0].alive()).toBe(false);
    expect(forwards.snapshot()).toEqual([]);
  });

  test("forwards are saved as they change, and not forgotten when the app quits", async () => {
    const { forwards, saves } = setup({ taken: [8788] });
    await forwards.forward(WS, 8788);
    expect(saves.at(-1)).toEqual([WS, [{ remotePort: 8788, localPort: 8789 }]]);
    forwards.dispose();
    expect(saves.at(-1)).toEqual([WS, [{ remotePort: 8788, localPort: 8789 }]]);
  });

  test("a removed workspace's saved forwards are forgotten", async () => {
    const { forwards, saves } = setup();
    await forwards.forward(WS, 3000);
    forwards.removed(WS);
    expect(saves.at(-1)).toEqual([WS, []]);
  });

  test("saved forwards come back when their workspace connects, on their ports here", async () => {
    const { forwards, opened } = setup({
      saved: { [WS]: [{ remotePort: 8788, localPort: 8789 }] },
    });
    expect(forwards.list(WS)).toEqual([{ remotePort: 8788, localPort: 8789, active: false }]);
    forwards.connectionChanged(WS, "connected");
    await Bun.sleep(0);
    expect(opened).toEqual([expect.objectContaining({ remotePort: 8788, localPort: 8789 })]);
  });

  test("a tab left on a saved forward's local port reaches its remote port", async () => {
    const { forwards, opened } = setup({
      saved: { [WS]: [{ remotePort: 8788, localPort: 8789 }] },
    });
    expect(forwards.rewrites(WS, "http://localhost:8789/x")).toBe(true);
    expect(await forwards.localUrl(WS, "http://localhost:8789/x")).toBe("http://localhost:8789/x");
    expect(opened).toEqual([expect.objectContaining({ remotePort: 8788, localPort: 8789 })]);
    // Set up now, the page loads as it is.
    expect(forwards.rewrites(WS, "http://localhost:8789/x")).toBe(false);
  });
});
