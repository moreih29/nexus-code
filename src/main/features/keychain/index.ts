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

export async function createKeychain(options: {
  userData: string;
  state: Pick<StateService, "getState" | "setState">;
  warn(message: string): void;
  info(message: string): void;
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
    info: options.info,
  });
}

export function registerKeychainChannel(keychain: KeychainControl): { dispose(): void } {
  let prompt: { owner: WebContents; done: Promise<void>; release: () => void } | undefined;
  let disposed = false;
  const unsubscribe = keychain.subscribe((status) => {
    if (status.state !== "ask") prompt?.release();
  });

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
