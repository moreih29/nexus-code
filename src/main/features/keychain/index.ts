// The keychain IPC channel: whether the app's sealed files wait on the macOS
// keychain, the windows' one question about opening it, and the settings'
// button that opens it.

import type { WebContents } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import type { KeychainStatus } from "../../../shared/keychain";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { electronSecretBox } from "../remote/sealed-file";
import { sealedItems } from "./files";
import { type KeychainControl, KeychainGate, openKeychain } from "./gate";
import { appSignature } from "./signature";

/**
 * The keychain the features seal with. On macOS nothing is read here: the
 * running app's signature is looked up only when sealed files are there.
 */
export async function createKeychain(options: {
  userData: string;
  state: Pick<StateService, "getState" | "setState">;
  warn(message: string): void;
  platform?: NodeJS.Platform;
}): Promise<KeychainControl> {
  const platform = options.platform ?? process.platform;
  const box = await electronSecretBox(platform).catch((error: unknown) => {
    options.warn(`no keychain: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (platform !== "darwin" || !box) return openKeychain(box, options.warn);
  return new KeychainGate({
    raw: box,
    items: () => sealedItems(options.userData),
    signature: () => appSignature(),
    recorded: {
      get: () => options.state.getState().keychainSignature ?? null,
      set: (keychainSignature) => options.state.setState({ keychainSignature }),
    },
    onChange: (status) => broadcast("keychain", "changed", status),
    warn: options.warn,
  });
}

export function registerKeychainChannel(keychain: KeychainControl): { dispose(): void } {
  let prompt: { owner: WebContents; done: Promise<void>; release: () => void } | undefined;
  let disposed = false;
  // Opened from elsewhere (another window, the settings' button, what the user did): the
  // question is over, and its window closes it unanswered.
  const unsubscribe = keychain.subscribe((status) => {
    if (status.state !== "ask") prompt?.release();
  });

  /** The first window to ask shows the question; the others wait for its answer or its closing. */
  async function claimPrompt(owner?: WebContents): Promise<{
    prompt: boolean;
    status: KeychainStatus;
  }> {
    await keychain.decided();
    while (true) {
      const status = keychain.status();
      if (disposed || !owner || owner.isDestroyed() || status.state !== "ask") {
        return { prompt: false, status };
      }
      if (!prompt) {
        let resolve = () => {};
        const done = new Promise<void>((settled) => {
          resolve = settled;
        });
        const release = () => {
          if (prompt?.release !== release) return;
          prompt = undefined;
          owner.removeListener("destroyed", release);
          resolve();
        };
        prompt = { owner, done, release };
        owner.once("destroyed", release);
      }
      if (prompt.owner === owner) return { prompt: true, status };
      await prompt.done;
    }
  }

  const c = ipcContract.keychain.call;
  register("keychain", {
    keepOnRendererClose: ["answer", "open"],
    call: {
      status: async () => ipcOk(keychain.status()),
      claimPrompt: async (_args, ctx) => ipcOk(await claimPrompt(ctx?.sender)),
      answer: async (args, ctx) => {
        const { open } = validateArgs(c.answer.args, args);
        const asking = prompt;
        if (!asking || asking.owner !== ctx?.sender || keychain.status().state !== "ask") {
          return ipcOk(keychain.status());
        }
        try {
          if (open) {
            // The question closes as reading starts; macOS asks next.
            const opening = keychain.open();
            asking.release();
            await opening;
          } else keychain.putOff();
        } finally {
          asking.release();
        }
        return ipcOk(keychain.status());
      },
      open: async () => {
        await keychain.open();
        return ipcOk(keychain.status());
      },
    },
    listen: { changed: {} },
  });

  return {
    dispose: () => {
      disposed = true;
      unsubscribe();
      prompt?.release();
    },
  };
}
