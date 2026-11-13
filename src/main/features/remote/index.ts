// The remote IPC channel: the NexusCode account the remote runs on.

import { join } from "node:path";
import { app, shell } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { RemoteAccount } from "./account";
import { AccountStore, electronSecretBox } from "./account-store";
import { ServerError, SignedOutError } from "./errors";

const c = ipcContract.remote.call;

/** The server in development (wrangler dev); NEXUS_REMOTE_SERVER names another. */
export const DEV_SERVER = "http://localhost:8787";

export function remoteServer(): string {
  return process.env.NEXUS_REMOTE_SERVER?.trim() || DEV_SERVER;
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
    if (error instanceof ServerError || error instanceof TypeError) {
      // TypeError: fetch could not reach the server.
      return ipcErr("unavailable", error.message);
    }
    throw error;
  }
}

export async function registerRemoteChannel(): Promise<{
  account: RemoteAccount;
  dispose(): void;
}> {
  const store = new AccountStore(
    join(app.getPath("userData"), "remote-account.bin"),
    await electronSecretBox(),
  );
  const account = new RemoteAccount({
    server: remoteServer(),
    store,
    openExternal: (url) => shell.openExternal(url),
    onChange: (state) => broadcast("remote", "accountChanged", state),
  });
  await account.restore();

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
    },
    listen: {
      accountChanged: {},
    },
  });

  return { account, dispose: () => account.cancelSignIn() };
}
