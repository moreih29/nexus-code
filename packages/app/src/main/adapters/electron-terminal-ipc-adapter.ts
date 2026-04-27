import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  TerminalMainIpcAdapter,
  TerminalMainIpcDisposable,
} from "../terminal/terminal-ipc";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;
type TerminalEventSink = Pick<WebContents, "send"> & {
  isDestroyed?: () => boolean;
};

export interface ElectronTerminalIpcAdapterOptions {
  ipcMain: IpcMainLike;
  resolveEventSink: () => TerminalEventSink | null | undefined;
}

export class ElectronTerminalIpcAdapter implements TerminalMainIpcAdapter {
  private commandSubscription: TerminalMainIpcDisposable | null = null;

  public constructor(private readonly options: ElectronTerminalIpcAdapterOptions) {}

  public onCommand(
    handler: (payload: unknown) => Promise<unknown> | unknown,
  ): TerminalMainIpcDisposable {
    if (this.commandSubscription !== null) {
      throw new Error("Terminal invoke handler is already registered.");
    }

    const invokeHandler = (_event: IpcMainInvokeEvent, payload: unknown): Promise<unknown> | unknown => {
      return handler(payload);
    };

    this.options.ipcMain.handle(TERMINAL_INVOKE_CHANNEL, invokeHandler);

    const subscription: TerminalMainIpcDisposable = {
      dispose: () => {
        if (this.commandSubscription !== subscription) {
          return;
        }
        this.options.ipcMain.removeHandler(TERMINAL_INVOKE_CHANNEL);
        this.commandSubscription = null;
      },
    };

    this.commandSubscription = subscription;
    return subscription;
  }

  public sendEvent(payload: unknown): void {
    const eventSink = this.options.resolveEventSink();
    if (!eventSink || eventSink.isDestroyed?.()) {
      return;
    }

    eventSink.send(TERMINAL_EVENT_CHANNEL, payload);
  }
}
