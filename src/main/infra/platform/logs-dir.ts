import path from "node:path";
import { defaultRoot, root } from "../agent/runtimeDirs";

export interface LogsDirPlace {
  readonly packaged: boolean;
  readonly userData: string;
  readonly defaultUserData: string;
  readonly nexusHome: string;
  readonly defaultNexusHome: string;
}

export function ownLogsDir(place: LogsDirPlace): string | null {
  if (path.resolve(place.userData) !== path.resolve(place.defaultUserData)) {
    return path.join(place.userData, "logs");
  }
  if (!place.packaged || path.resolve(place.nexusHome) !== path.resolve(place.defaultNexusHome)) {
    return path.join(place.nexusHome, "logs");
  }
  return null;
}

export type LogsDirApp = Pick<
  import("electron").App,
  "isPackaged" | "name" | "getPath" | "setAppLogsPath"
>;

export const APP_DATA_UNAVAILABLE =
  "The app data folder is unavailable, so this run keeps its logs with its own user data";

export function keepLogsApart(
  app: LogsDirApp,
  nexusHome: string = root(),
  defaultNexusHome: string = defaultRoot(),
): string | null {
  const userData = app.getPath("userData");
  let appData: string;
  try {
    appData = app.getPath("appData");
  } catch {
    app.setAppLogsPath(path.join(userData, "logs"));
    return APP_DATA_UNAVAILABLE;
  }
  const dir = ownLogsDir({
    packaged: app.isPackaged,
    userData,
    defaultUserData: path.join(appData, app.name),
    nexusHome,
    defaultNexusHome,
  });
  if (dir !== null) app.setAppLogsPath(dir);
  return null;
}
