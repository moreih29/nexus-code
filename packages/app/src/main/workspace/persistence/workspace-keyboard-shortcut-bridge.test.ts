import { describe, expect, test } from "bun:test";
import type { Input } from "electron";

import type { WorkspaceSidebarState } from "../../../../../shared/src/contracts/workspace/workspace-shell";
import {
  executeWorkspaceKeyboardCommand,
  registerWorkspaceKeyboardShortcutBridge,
  resolveWorkspaceKeyboardCommand,
} from "./workspace-keyboard-shortcut-bridge";

const EMPTY_STATE: WorkspaceSidebarState = {
  openWorkspaces: [],
  activeWorkspaceId: null,
};

const THREE_WORKSPACES_STATE: WorkspaceSidebarState = {
  openWorkspaces: [
    {
      id: "ws_alpha",
      absolutePath: "/tmp/nexus/alpha",
      displayName: "Alpha",
    },
    {
      id: "ws_beta",
      absolutePath: "/tmp/nexus/beta",
      displayName: "Beta",
    },
    {
      id: "ws_gamma",
      absolutePath: "/tmp/nexus/gamma",
      displayName: "Gamma",
    },
  ],
  activeWorkspaceId: "ws_beta",
};

describe("workspace-keyboard-shortcut-bridge", () => {
  test("resolves direct slot keyboard input (Mod+1..9)", () => {
    const command = resolveWorkspaceKeyboardCommand(
      createInput({
        key: "2",
        code: "Digit2",
      }),
    );

    expect(command).toEqual({
      type: "workspace/switch-direct-slot",
      slotNumber: 2,
    });
  });

  test("resolves previous/next cycle keyboard input (Mod+Alt+ArrowLeft/ArrowRight)", () => {
    const previousCommand = resolveWorkspaceKeyboardCommand(
      createInput({
        alt: true,
        key: "ArrowLeft",
        code: "ArrowLeft",
      }),
    );
    const nextCommand = resolveWorkspaceKeyboardCommand(
      createInput({
        alt: true,
        key: "ArrowRight",
        code: "ArrowRight",
      }),
    );

    expect(previousCommand).toEqual({
      type: "workspace/switch-cycle",
      direction: "previous",
    });
    expect(nextCommand).toEqual({
      type: "workspace/switch-cycle",
      direction: "next",
    });
  });

  test("ignores keyUp events", () => {
    const command = resolveWorkspaceKeyboardCommand(
      createInput({
        type: "keyUp",
        key: "1",
        code: "Digit1",
      }),
    );

    expect(command).toBeNull();
  });

  test("execute command activates expected workspace and returns updated state", async () => {
    const workspaceService = new FakeWorkspaceShellService();
    workspaceService.sidebarState = THREE_WORKSPACES_STATE;

    await expect(
      executeWorkspaceKeyboardCommand(workspaceService, {
        type: "workspace/switch-direct-slot",
        slotNumber: 1,
      }),
    ).resolves.toEqual({
      ...THREE_WORKSPACES_STATE,
      activeWorkspaceId: "ws_alpha",
    });

    await expect(
      executeWorkspaceKeyboardCommand(workspaceService, {
        type: "workspace/switch-cycle",
        direction: "next",
      }),
    ).resolves.toEqual({
      ...THREE_WORKSPACES_STATE,
      activeWorkspaceId: "ws_beta",
    });

    expect(workspaceService.activateCalls).toEqual(["ws_alpha", "ws_beta"]);
  });

  test("bridge listener handles before-input-event and can be disposed", async () => {
    const workspaceService = new FakeWorkspaceShellService();
    workspaceService.sidebarState = THREE_WORKSPACES_STATE;
    const webContents = new FakeWebContents();
    const sidebarUpdates: WorkspaceSidebarState[] = [];

    const bridge = registerWorkspaceKeyboardShortcutBridge({
      webContents,
      workspaceShellService: workspaceService,
      onSidebarStateChanged: (nextState) => {
        sidebarUpdates.push(nextState);
      },
    });

    const handledEvent = webContents.emitBeforeInputEvent(
      createInput({
        key: "1",
        code: "Digit1",
      }),
    );
    await flushAsyncTasks();

    expect(handledEvent.preventDefaultCalls).toBe(1);
    expect(workspaceService.activateCalls).toEqual(["ws_alpha"]);
    expect(sidebarUpdates).toEqual([
      {
        ...THREE_WORKSPACES_STATE,
        activeWorkspaceId: "ws_alpha",
      },
    ]);

    bridge.dispose();
    webContents.emitBeforeInputEvent(
      createInput({
        key: "2",
        code: "Digit2",
      }),
    );
    await flushAsyncTasks();

    expect(workspaceService.activateCalls).toEqual(["ws_alpha"]);
  });

  test("bridge ignores non-matching keyboard input", async () => {
    const workspaceService = new FakeWorkspaceShellService();
    workspaceService.sidebarState = THREE_WORKSPACES_STATE;
    const webContents = new FakeWebContents();

    registerWorkspaceKeyboardShortcutBridge({
      webContents,
      workspaceShellService: workspaceService,
    });

    const event = webContents.emitBeforeInputEvent(
      createInput({
        key: "1",
        code: "Digit1",
        overridePrimaryModifier: false,
      }),
    );
    await flushAsyncTasks();

    expect(event.preventDefaultCalls).toBe(0);
    expect(workspaceService.activateCalls).toEqual([]);
  });
});

type InputOverrides = Partial<Input> & {
  overridePrimaryModifier?: boolean;
};

function createInput(overrides: InputOverrides): Input {
  const { overridePrimaryModifier, ...inputOverrides } = overrides;
  const usePrimaryModifier = overridePrimaryModifier ?? true;
  const baseInput: Input = {
    type: "keyDown",
    key: "",
    code: "",
    alt: false,
    control: false,
    shift: false,
    meta: false,
    isAutoRepeat: false,
    isComposing: false,
    modifiers: [],
  };

  if (usePrimaryModifier) {
    if (process.platform === "darwin") {
      baseInput.meta = true;
      baseInput.modifiers = ["meta"];
    } else {
      baseInput.control = true;
      baseInput.modifiers = ["control"];
    }
  }

  return {
    ...baseInput,
    ...inputOverrides,
  };
}

async function flushAsyncTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeWorkspaceShellService {
  public sidebarState: WorkspaceSidebarState = EMPTY_STATE;
  public readonly activateCalls: string[] = [];

  public async getSidebarState(): Promise<WorkspaceSidebarState> {
    return this.sidebarState;
  }

  public async activateWorkspace(workspaceId: string): Promise<WorkspaceSidebarState> {
    this.activateCalls.push(workspaceId);
    this.sidebarState = {
      ...this.sidebarState,
      activeWorkspaceId: workspaceId,
    };
    return this.sidebarState;
  }
}

class FakeBeforeInputEvent {
  public preventDefaultCalls = 0;

  public preventDefault(): void {
    this.preventDefaultCalls += 1;
  }
}

class FakeWebContents {
  private listener: ((event: FakeBeforeInputEvent, input: Input) => void) | null = null;

  public on(
    channel: "before-input-event",
    listener: (event: FakeBeforeInputEvent, input: Input) => void,
  ): void {
    if (channel !== "before-input-event") {
      return;
    }
    this.listener = listener;
  }

  public off(
    channel: "before-input-event",
    listener: (event: FakeBeforeInputEvent, input: Input) => void,
  ): void {
    if (channel !== "before-input-event") {
      return;
    }
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  public emitBeforeInputEvent(input: Input): FakeBeforeInputEvent {
    const event = new FakeBeforeInputEvent();
    this.listener?.(event, input);
    return event;
  }
}
