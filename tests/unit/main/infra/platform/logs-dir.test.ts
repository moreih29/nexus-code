import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  keepLogsApart,
  type LogsDirApp,
  ownLogsDir,
} from "../../../../../src/main/infra/platform/logs-dir";

const APP_DATA = path.join("/Users", "me", "Library", "Application Support");
const DEFAULT_USER_DATA = path.join(APP_DATA, "NexusCode");
const DEFAULT_HOME = path.join("/Users", "me", ".nexus-code");
const DEV_USER_DATA = path.join("/repo", "scripts", "_local", "mac-dev", "userdata");
const DEV_HOME = path.join("/Users", "me", ".nexus-code-dev");

const installed = {
  packaged: true,
  userData: DEFAULT_USER_DATA,
  defaultUserData: DEFAULT_USER_DATA,
  nexusHome: DEFAULT_HOME,
  defaultNexusHome: DEFAULT_HOME,
};

describe("ownLogsDir", () => {
  test("the installed app keeps Electron's logs folder", () => {
    expect(ownLogsDir(installed)).toBeNull();
    expect(ownLogsDir({ ...installed, userData: `${DEFAULT_USER_DATA}${path.sep}` })).toBeNull();
  });

  test("a run with its own user data logs beside that data", () => {
    expect(
      ownLogsDir({ ...installed, packaged: false, userData: DEV_USER_DATA, nexusHome: DEV_HOME }),
    ).toBe(path.join(DEV_USER_DATA, "logs"));
    expect(ownLogsDir({ ...installed, userData: DEV_USER_DATA })).toBe(
      path.join(DEV_USER_DATA, "logs"),
    );
  });

  test("a development run on the default user data logs under its NexusCode home", () => {
    expect(ownLogsDir({ ...installed, packaged: false })).toBe(path.join(DEFAULT_HOME, "logs"));
    expect(ownLogsDir({ ...installed, packaged: false, nexusHome: DEV_HOME })).toBe(
      path.join(DEV_HOME, "logs"),
    );
  });

  test("an installed app pointed at another NexusCode home logs under that home", () => {
    expect(ownLogsDir({ ...installed, nexusHome: DEV_HOME })).toBe(path.join(DEV_HOME, "logs"));
  });
});

describe("keepLogsApart", () => {
  function fakeApp(packaged: boolean, userData: string) {
    const set: string[] = [];
    const app = {
      isPackaged: packaged,
      name: "NexusCode",
      getPath: (name: string) => (name === "appData" ? APP_DATA : userData),
      setAppLogsPath: (dir?: string) => {
        set.push(dir ?? "");
      },
    } as unknown as LogsDirApp;
    return { app, set };
  }

  test("moves the logs folder of the development app started by run-inspect", () => {
    const { app, set } = fakeApp(false, DEV_USER_DATA);
    keepLogsApart(app, DEV_HOME, DEFAULT_HOME);
    expect(set).toEqual([path.join(DEV_USER_DATA, "logs")]);
  });

  test("leaves the installed app's logs folder alone", () => {
    const { app, set } = fakeApp(true, DEFAULT_USER_DATA);
    keepLogsApart(app, DEFAULT_HOME, DEFAULT_HOME);
    expect(set).toEqual([]);
  });
});
