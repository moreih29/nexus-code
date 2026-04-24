import type {
  TerminalBridgeDisposable,
  TerminalBridgeTransport,
} from "../terminal-bridge";
import type { TerminalIpcCommand } from "../../../../shared/src/contracts/terminal-ipc";

export class PreloadTerminalBridgeTransport implements TerminalBridgeTransport {
  public invoke(command: unknown): Promise<unknown> {
    return window.nexusTerminal.invoke(command as TerminalIpcCommand);
  }

  public onEvent(listener: (eventPayload: unknown) => void): TerminalBridgeDisposable {
    return window.nexusTerminal.onEvent((eventPayload) => {
      listener(eventPayload);
    });
  }
}
