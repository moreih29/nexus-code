import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import type { RpcResult } from "../../../../../packages/remote-protocol/src/rpc";
import { RemoteInstructionsChip } from "../../../../../src/renderer/components/agent-view/remote-instructions-chip";
import * as popovers from "../../../../../src/renderer/components/ui/popover";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { usePeerReadsChats } from "../../../../../src/renderer/services/remote/room";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";
import { withTestDom } from "../../../../helpers/test-dom";

const chat = { deviceId: "d2", workspaceId: "w1", tabId: "t1" };

const layered: RpcResult<"chat.instructions"> = {
  instructions: "# Instructions set in NexusCode\n...",
  session: "Keep it short",
  layers: [
    { scope: { kind: "all" }, title: "All agents", text: "Be kind" },
    { scope: { kind: "agent", agent: "claude" }, title: "Claude", text: "" },
    { scope: { kind: "profile", id: "p1" }, title: "Profile: work", text: "Use work\nrules" },
    { scope: { kind: "workspace", id: "w0" }, title: "Workspace: api", text: "" },
  ],
};

type Calls = { channel: string; args: unknown }[];

function answer(
  read: () => ReturnType<typeof ipcOk> | ReturnType<typeof ipcErr> | Promise<never>,
  calls: Calls,
) {
  return spyOn(ipc, "ipcCallResult").mockImplementation(((
    _domain: string,
    channel: string,
    args: unknown,
  ) => {
    calls.push({ channel, args });
    if (channel === "peerChatInstructions") return Promise.resolve(read());
    if (channel === "peerChatInstructionsSet") {
      return Promise.resolve(ipcOk({ instructions: "combined" }));
    }
    return Promise.resolve(ipcOk(undefined));
  }) as never);
}

let spy: { mockRestore(): void } | undefined;
let popover: { mockRestore(): void } | undefined;
// Radix's portal does not mount in the test DOM: the panel shows in place while open.
beforeEach(() => {
  popover = spyOn(popovers, "Popover").mockImplementation(
    ({ open, onOpenChange, trigger, children, testId }) => (
      <>
        <span onClickCapture={() => onOpenChange(!open)}>{trigger}</span>
        {open && <div data-testid={testId}>{children}</div>}
      </>
    ),
  );
});
afterEach(() => {
  spy?.mockRestore();
  popover?.mockRestore();
});

function dispatch(node: Element, type: string) {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  node.dispatchEvent(event);
}

async function render(root: import("react-dom/client").Root, controls: boolean) {
  await act(async () =>
    root.render(
      <RemoteInstructionsChip
        chat={chat}
        deviceName="Work PC"
        profile="work"
        workspaceName="api"
        controls={controls}
        compact={false}
        onMenu={() => {}}
      />,
    ),
  );
}

// The test DOM answers no match with undefined, not null.
const chipOf = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-testid="session-instructions-chip"]')!;
const panelOf = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-testid="session-instructions-popover"]') ?? null;
const buttonNamed = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === name);

test("reads the other computer's layers, shown only, and its session layer to edit", async () => {
  const calls: Calls = [];
  spy = answer(() => ipcOk(layered), calls);
  await withTestDom(async (host, root) => {
    await render(root, true);
    const chip = chipOf(host);
    expect(chip.getAttribute("data-instructions")).toBe("ready");
    expect(chip.textContent).toBe("Instructions 3");
    await act(async () => chip.click());
    const panel = panelOf(host)!;
    const text = panel.textContent ?? "";
    expect(text).toContain("All agents");
    expect(text).toContain("Profile · work");
    expect(text).toContain("Workspace · api");
    expect(text).toContain("Edit the layers above in Settings on Work PC");
    // That computer's layers open nowhere here.
    expect(text).not.toContain("Edit in Settings");
    expect(panel.querySelector("textarea")?.value).toBe("Keep it short");
  });
  expect(calls[0]).toEqual({ channel: "peerChatInstructions", args: chat });
});

test("saves the session layer as the user, without an agent sender", async () => {
  const calls: Calls = [];
  spy = answer(() => ipcOk(layered), calls);
  await withTestDom(async (host, root) => {
    await render(root, true);
    await act(async () => chipOf(host).click());
    const area = panelOf(host)!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")?.set?.call(area, "");
      dispatch(area, "input");
    });
    await act(async () => buttonNamed(host, "Apply")?.click());
    const set = calls.find(({ channel }) => channel === "peerChatInstructionsSet");
    expect(set?.args).toEqual({ ...chat, text: "" });
    expect(panelOf(host)).toBeNull();
    // A blank session layer is none: the count drops it.
    expect(chipOf(host).textContent).toBe("Instructions 2");
  });
});

test("only shows the session layer where that computer does not allow control", async () => {
  spy = answer(() => ipcOk(layered), []);
  await withTestDom(async (host, root) => {
    await render(root, false);
    await act(async () => chipOf(host).click());
    const panel = panelOf(host)!;
    expect(panel.querySelector("textarea")).toBeFalsy();
    expect(buttonNamed(host, "Apply")).toBeUndefined();
    expect(panel.textContent).toContain("Keep it short");
    expect(panel.textContent).toContain("Control from other devices is off on Work PC");
  });
});

test("shows an older computer's combined text only, with nothing to set", async () => {
  spy = answer(() => ipcOk({ instructions: "## All agents\nBe kind" }), []);
  await withTestDom(async (host, root) => {
    await render(root, true);
    const chip = chipOf(host);
    expect(chip.textContent).toBe("Instructions");
    await act(async () => chip.click());
    const panel = panelOf(host)!;
    expect(panel.querySelector("pre")?.textContent).toBe("## All agents\nBe kind");
    expect(panel.querySelector("textarea")).toBeFalsy();
    expect(buttonNamed(host, "Apply")).toBeUndefined();
    expect(panel.textContent).toContain("Update NexusCode on Work PC");
  });
});

test("says it could not read them, and asks again on retry", async () => {
  const calls: Calls = [];
  let fail = true;
  spy = answer(() => (fail ? ipcErr("unavailable", "timed out") : ipcOk(layered)), calls);
  await withTestDom(async (host, root) => {
    await render(root, true);
    const chip = chipOf(host);
    expect(chip.getAttribute("data-instructions")).toBe("failed");
    expect(chip.getAttribute("aria-label")).toBe("Could not load instructions");
    await act(async () => chip.click());
    expect(panelOf(host)?.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load instructions",
    );
    fail = false;
    await act(async () => buttonNamed(host, "Retry")?.click());
    expect(chipOf(host).getAttribute("data-instructions")).toBe("ready");
    expect(panelOf(host)?.querySelector("textarea")?.value).toBe("Keep it short");
  });
  expect(calls.filter(({ channel }) => channel === "peerChatInstructions").length).toBe(3);
});

test("does not read a computer whose hello leaves out chat.read", async () => {
  const room = {
    status: "online",
    peers: [{ id: "d2", name: "Work PC", online: true, serves: ["sessions.list"] }],
  };
  spy = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(room) as never);
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const seen: boolean[] = [];
  function Probe() {
    seen.push(usePeerReadsChats("d2"));
    return null;
  }
  try {
    await withTestDom(async (_host, root) => {
      await act(async () => root.render(<Probe />));
    });
  } finally {
    listen.mockRestore();
  }
  // Taken as yes until the hello says, then no.
  expect(seen[0]).toBe(true);
  expect(seen.at(-1)).toBe(false);
});
