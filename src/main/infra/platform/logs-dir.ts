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

export function keepLogsApart(
  app: LogsDirApp,
  nexusHome: string = root(),
  defaultNexusHome: string = defaultRoot(),
): void {
  const dir = ownLogsDir({
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    defaultUserData: path.join(app.getPath("appData"), app.name),
    nexusHome,
    defaultNexusHome,
  });
  if (dir !== null) app.setAppLogsPath(dir);
}
