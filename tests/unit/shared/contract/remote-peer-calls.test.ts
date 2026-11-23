import { describe, expect, it } from "bun:test";
import { RPC_METHODS } from "../../../../packages/remote-protocol/src/rpc";
import { ipcContract } from "../../../../src/shared/ipc/contract";

const c = ipcContract.remote.call;
const tab = { deviceId: "d2", workspaceId: "w1", tabId: "t1" };

describe("remote peer calls for the agent view's list", () => {
  it("open a chat there, with an agent and, if picked, a profile", () => {
    expect(
      c.peerChatNew.args.safeParse({
        deviceId: "d2",
        workspaceId: "w1",
        agent: "codex",
        profile: "codex-ab12",
      }).success,
    ).toBe(true);
    expect(c.peerChatNew.args.safeParse({ deviceId: "d2", workspaceId: "w1" }).success).toBe(false);
    expect(c.peerChatNew.result).toBe(RPC_METHODS["chat.new"].result);
  });

  it("rename a chat or a terminal there, with a title", () => {
    expect(c.peerChatRename.args.safeParse({ ...tab, title: "Fix" }).success).toBe(true);
    expect(c.peerTerminalRename.args.safeParse({ ...tab, title: "dev" }).success).toBe(true);
    expect(c.peerTerminalRename.args.safeParse({ ...tab, title: "" }).success).toBe(false);
  });

  it("list a workspace's shells, and close a terminal, forced or not", () => {
    expect(c.peerTerminalShells.args.safeParse({ deviceId: "d2", workspaceId: "w1" }).success).toBe(
      true,
    );
    expect(c.peerTerminalClose.args.parse({ ...tab, force: true })).toEqual({
      ...tab,
      force: true,
    });
    expect(c.peerTerminalClose.args.safeParse(tab).success).toBe(true);
  });

  it("answer a terminal's Claude Code with one of its four answers", () => {
    for (const decision of ["allow", "allowAlways", "deny", "denyStop"]) {
      expect(
        c.peerTerminalAnswer.args.safeParse({ ...tab, requestId: "r1", decision }).success,
      ).toBe(true);
    }
    expect(
      c.peerTerminalAnswer.args.safeParse({ ...tab, requestId: "r1", decision: "maybe" }).success,
    ).toBe(false);
  });

  it("answer a consent prompt there: once, until restart, or no", () => {
    for (const answer of ["once", "session", "deny"]) {
      expect(c.peerConsentAnswer.args.safeParse({ deviceId: "d2", id: "c1", answer }).success).toBe(
        true,
      );
    }
    expect(
      c.peerConsentAnswer.args.safeParse({ deviceId: "d2", id: "c1", answer: "always" }).success,
    ).toBe(false);
    expect(c.peerConsentAnswer.args.safeParse({ id: "c1", answer: "once" }).success).toBe(false);
  });
});
