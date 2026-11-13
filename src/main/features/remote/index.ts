// The remote IPC channel: the NexusCode account the remote runs on.

import { join } from "node:path";
import { app, shell } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { AccountKeyState } from "../../../shared/remote/account";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { RemoteAccount, SavedAccountSchema } from "./account";
import { AccountKeys, KeyError, SavedKeySchema } from "./account-keys";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import { electronSecretBox, SealedFile } from "./sealed-file";

const c = ipcContract.remote.call;

/** The server in development (wrangler dev); NEXUS_REMOTE_SERVER names another. */
export const DEV_SERVER = "http://localhost:8787";

export function remoteServer(): string {
  return process.env.NEXUS_REMOTE_SERVER?.trim() || DEV_SERVER;
}

/**
 * For development: NEXUS_REMOTE_PROVIDER=dev signs in with the dev server's
 * own sign-in instead of Google, as NEXUS_REMOTE_LOGIN_HINT's email when set.
 */
function signInOptions(): { provider?: "dev"; loginHint?: string } {
  const loginHint = process.env.NEXUS_REMOTE_LOGIN_HINT?.trim();
  return {
    ...(process.env.NEXUS_REMOTE_PROVIDER?.trim() === "dev" ? { provider: "dev" as const } : {}),
    ...(loginHint ? { loginHint } : {}),
  };
}

/** Asks the server for the renderer: how it failed, where the renderer can act on it. */
async function ask<T>(question: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ipcOk(await question());
  } catch (error) {
    if (error instanceof SignedOutError) return ipcErr("session-expired", error.message);
    if (error instanceof ServerError && error.status === 404) {
      return ipcErr("not-found", error.message);
    }
    if (error instanceof ServerError || error instanceof UnreachableError) {
      return ipcErr("unavailable", error.message);
    }
    throw error;
  }
}

/** Runs an account password flow for the renderer: its KeyFailure as the kind when it fails. */
async function keyFlow(flow: () => Promise<AccountKeyState>): Promise<IpcResult<AccountKeyState>> {
  try {
    return ipcOk(await flow());
  } catch (error) {
    if (error instanceof KeyError) {
      return ipcErr(error.failure, error.message, error.retryAt ? { retryAt: error.retryAt } : {});
    }
    throw error;
  }
}

export async function registerRemoteChannel(): Promise<{
  account: RemoteAccount;
  keys: AccountKeys;
  dispose(): void;
}> {
  const box = await electronSecretBox();
  const store = new SealedFile(
    join(app.getPath("userData"), "remote-account.bin"),
    box,
    SavedAccountSchema,
  );
  let keys: AccountKeys | null = null;
  const account = new RemoteAccount({
    server: remoteServer(),
    store,
    openExternal: (url) => shell.openExternal(url),
    ...signInOptions(),
    onChange: (state) => {
      broadcast("remote", "accountChanged", state);
      void keys?.accountChanged(state).catch(() => {});
    },
  });
  await account.restore();
  const accountKeys = new AccountKeys({
    account,
    store: new SealedFile(join(app.getPath("userData"), "remote-key.bin"), box, SavedKeySchema),
    onChange: (state) => broadcast("remote", "keyChanged", state),
  });
  keys = accountKeys;
  // Asks the server where the key stands; the app does not wait for it.
  void accountKeys.restore();

  register("remote", {
    call: {
      account: async () => ipcOk(account.state()),
      signIn: async () => ipcOk(await account.signIn()),
      cancelSignIn: async () => {
        account.cancelSignIn();
        return ipcOk(undefined);
      },
      signOut: async () => {
        await account.signOut();
        return ipcOk(undefined);
      },
      devices: () => ask(() => account.devices()),
      removeDevice: (args: unknown) => {
        const { id } = validateArgs(c.removeDevice.args, args);
        return ask(() => account.removeDevice(id));
      },
      key: async () => ipcOk(accountKeys.state()),
      refreshKey: () => keyFlow(() => accountKeys.refresh()),
      createKey: (args: unknown) => {
        const { password } = validateArgs(c.createKey.args, args);
        return keyFlow(() => accountKeys.create(password));
      },
      unlockKey: (args: unknown) => {
        const { password } = validateArgs(c.unlockKey.args, args);
        return keyFlow(() => accountKeys.unlock(password));
      },
      changePassword: (args: unknown) => {
        const { current, next } = validateArgs(c.changePassword.args, args);
        return keyFlow(() => accountKeys.changePassword(current, next));
      },
      resetKey: (args: unknown) => {
        const { password } = validateArgs(c.resetKey.args, args);
        return keyFlow(() => accountKeys.reset(password));
      },
    },
    listen: {
      accountChanged: {},
      keyChanged: {},
    },
  });

  return { account, keys: accountKeys, dispose: () => account.cancelSignIn() };
}
