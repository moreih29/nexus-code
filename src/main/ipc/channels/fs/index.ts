/**
 * fs channel — registers the per-handler implementations defined in the
 * sibling files. `read-handlers.ts`, `write-handlers.ts`, and
 * `move-handlers.ts` each own one responsibility; this module only
 * wires them into the router so the channel itself stays a thin
 * map without growing.
 */
import type { FileWatcher } from "../../../filesystem/file-watcher";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { register } from "../../router";
import { showItemInFolderHandler } from "./move-handlers";
import {
  getExpandedHandler,
  readdirHandler,
  readExternalHandler,
  readFileHandler,
  setExpandedHandler,
  statHandler,
  unwatchHandler,
  watchHandler,
} from "./read-handlers";
import { createFileHandler, mkdirHandler, writeFileHandler } from "./write-handlers";

// NOTE: do not re-export individual handler factories here — `move-handlers`
// imports Electron's `shell` module which can't be loaded by Bun's test
// runtime. Tests should reach into the sub-files directly
// (`./read-handlers`, `./path-safety`, etc.). Production code only needs
// `registerFsChannel` from this barrel.

export function registerFsChannel(
  manager: WorkspaceManager,
  watcher: FileWatcher,
  storage: WorkspaceStorage,
): void {
  register("fs", {
    call: {
      readdir: readdirHandler(manager),
      stat: statHandler(manager),
      watch: watchHandler(manager, watcher),
      unwatch: unwatchHandler(manager, watcher),
      getExpanded: getExpandedHandler(manager, storage),
      setExpanded: setExpandedHandler(manager, storage),
      readFile: readFileHandler(manager),
      readExternal: readExternalHandler(),
      writeFile: writeFileHandler(manager),
      createFile: createFileHandler(manager),
      mkdir: mkdirHandler(manager),
      showItemInFolder: showItemInFolderHandler(manager),
    },
    listen: {},
  });
}
