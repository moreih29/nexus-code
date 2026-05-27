/**
 * fs channel — registers the per-handler implementations defined in the
 * sibling files. This module only wires them into the router so the
 * channel itself stays a thin map without growing.
 */
import { register } from "../../../infra/ipc-router";
import { showItemInFolderHandler } from "../../shell/workspace-reveal";
import type { WorkspaceStorage } from "../../../infra/storage/workspace-storage";
import type { WorkspaceManager } from "../../workspace/manager";
import { searchTextStream } from "../../search";
import type { AgentFsWatcher } from "../bridge/agent-watch";
import { getExpandedHandler, setExpandedHandler } from "./expanded-handlers";
import { readdirHandler, readExternalHandler, readFileHandler, statHandler } from "./read-handlers";
import { unwatchHandler, watchHandler } from "./watch-handlers";
import {
  copyFileHandler,
  createFileHandler,
  mkdirHandler,
  removeAllHandler,
  renameHandler,
  rmdirHandler,
  unlinkHandler,
  writeFileHandler,
} from "./write-handlers";

// NOTE: production code only needs `registerFsChannel` from this barrel.

export function registerFsChannel(
  manager: WorkspaceManager,
  watcher: AgentFsWatcher,
  storage: WorkspaceStorage,
): void {
  register("fs", {
    call: {
      readdir: readdirHandler(manager),
      stat: statHandler(manager),
      watch: watchHandler(watcher),
      unwatch: unwatchHandler(watcher),
      getExpanded: getExpandedHandler(manager, storage),
      setExpanded: setExpandedHandler(manager, storage),
      readFile: readFileHandler(manager),
      readExternal: readExternalHandler(manager),
      writeFile: writeFileHandler(manager),
      createFile: createFileHandler(manager),
      mkdir: mkdirHandler(manager),
      unlink: unlinkHandler(manager),
      rmdir: rmdirHandler(manager),
      rename: renameHandler(manager),
      copyFile: copyFileHandler(manager),
      removeAll: removeAllHandler(manager),
      showItemInFolder: showItemInFolderHandler(manager),
    },
    listen: {
      changed: {},
    },
    stream: {
      searchText: searchTextStream(manager),
    },
  });
}
