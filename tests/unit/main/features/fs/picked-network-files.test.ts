import { describe, expect, it, mock } from "bun:test";
import type { IpcMain, IpcMainEvent } from "electron";
import {
  editorTabFiles,
  fileOnRootShare,
  keepPickedNetworkFilesOpenIn,
  MAX_PENDING_PICKS,
  pickedNetworkFile,
  rememberPickedNetworkFile,
  restorePickedNetworkFiles,
} from "../../../../../src/main/features/fs/outside-grants";
import { registerPickedFileHandler } from "../../../../../src/main/features/fs/picked-attachment";
import { REMEMBER_PICKED_FILE } from "../../../../../src/shared/fs/picked-attachment";
import { ipcContract } from "../../../../../src/shared/ipc/contract";
import type { AppState } from "../../../../../src/shared/types/app-state";
import { AppStateSchema } from "../../../../../src/shared/types/app-state";

const WINDOWS = process.platform === "win32";
const PICKED = String.raw`\\nas\share\doc.txt`;
const TAB = "//NAS/share/doc.txt";

function freshStart(saved: readonly string[] = [], open: readonly string[] = []) {
  const saves: string[][] = [];
  restorePickedNetworkFiles(saved, open, (files) => saves.push(files));
  return saves;
}

describe("names that fold only in ASCII", () => {
  const KELVIN = "K";

  it.if(WINDOWS)("treat shares as one only when other letters match exactly", () => {
    expect(fileOnRootShare("//NAS/Share/x.txt", "//nas/share/w")).toBe(
      String.raw`\\NAS\Share\x.txt`,
    );
    expect(fileOnRootShare("//NAS/문서/x.txt", "//nas/문서/w")).toBe("\\\\NAS\\문서\\x.txt");
    expect(fileOnRootShare("//nas/문서/x.txt", "//NAS/문서/w")).toBe("\\\\nas\\문서\\x.txt");
    expect(fileOnRootShare("//nas/문서2/x.txt", "//nas/문서/w")).toBeUndefined();
    expect(fileOnRootShare("//nas/문서/x.txt", "//nas/문서2/w")).toBeUndefined();
    expect(fileOnRootShare(`//${KELVIN}nas/share/x.txt`, "//knas/share/w")).toBeUndefined();
    expect(fileOnRootShare(`//knas/share/x.txt`, `//${KELVIN}nas/share/w`)).toBeUndefined();
    expect(fileOnRootShare(`//${KELVIN}nas/share/x.txt`, `//${KELVIN}nas/share/w`)).toBe(
      `\\\\${KELVIN}nas\\share\\x.txt`,
    );
    expect(fileOnRootShare(`//nas/${KELVIN}s/x.txt`, `//nas/${KELVIN}s/w`)).toBe(
      `\\\\nas\\${KELVIN}s\\x.txt`,
    );
    expect(fileOnRootShare("//ｎａｓ/share/x.txt", "//nas/share/w")).toBeUndefined();
    expect(fileOnRootShare("//nas/share/x.txt", "//ｎａｓ/share/w")).toBeUndefined();
    expect(fileOnRootShare("//ＮＡＳ/share/x.txt", "//ｎａｓ/share/w")).toBeUndefined();
    expect(fileOnRootShare("//ｎａｓ/share/x.txt", "//ｎａｓ/share/w")).toBe(
      "\\\\ｎａｓ\\share\\x.txt",
    );
    expect(fileOnRootShare("//nas/share/한글.txt", "//nas/share/w")).toBe(
      "\\\\nas\\share\\한글.txt",
    );
  });

  it.if(WINDOWS)("match a picked file only under ASCII case changes", () => {
    freshStart();
    rememberPickedNetworkFile(String.raw`\\knas\share\K.txt`);
    rememberPickedNetworkFile("\\\\nas\\share\\Ä.txt");
    expect(pickedNetworkFile("//KNAS/share/k.txt")).toBe(String.raw`\\knas\share\K.txt`);
    expect(pickedNetworkFile(`//${KELVIN}nas/share/K.txt`)).toBeUndefined();
    expect(pickedNetworkFile(`//knas/share/${KELVIN}.txt`)).toBeUndefined();
    expect(pickedNetworkFile("//NAS/share/Ä.txt")).toBe("\\\\nas\\share\\Ä.txt");
    expect(pickedNetworkFile("//nas/share/ä.txt")).toBeUndefined();
  });
});

describe("picked network files", () => {
  it.if(WINDOWS)("keeps a picked file while a tab shows it, and forgets it when closed", () => {
    const saves = freshStart();
    rememberPickedNetworkFile(PICKED);
    expect(pickedNetworkFile(TAB)).toBe(PICKED);
    expect(saves).toEqual([]);

    keepPickedNetworkFilesOpenIn(["C:/w/a.ts", TAB]);
    expect(saves).toEqual([[PICKED]]);
    expect(pickedNetworkFile(TAB)).toBe(PICKED);

    keepPickedNetworkFilesOpenIn([TAB]);
    expect(saves).toHaveLength(1);

    keepPickedNetworkFilesOpenIn(["C:/w/a.ts"]);
    expect(saves).toEqual([[PICKED], []]);
    expect(pickedNetworkFile(TAB)).toBeUndefined();
  });

  it.if(WINDOWS)("opens a kept file's tab again after a restart", () => {
    const saves = freshStart([PICKED], [TAB]);
    expect(saves).toEqual([]);
    expect(pickedNetworkFile(TAB)).toBe(PICKED);
  });

  it.if(WINDOWS)("drops a saved file at start when no tab shows it", () => {
    const saves = freshStart([PICKED, String.raw`\\?\UNC\nas\share\x.txt`, "C:/a.txt"], []);
    expect(saves).toEqual([[]]);
    expect(pickedNetworkFile(TAB)).toBeUndefined();
  });

  it.if(WINDOWS)("never takes a tab's path the user did not pick", () => {
    const saves = freshStart();
    keepPickedNetworkFilesOpenIn(["//evil/share/a.txt", TAB]);
    expect(saves).toEqual([]);
    expect(pickedNetworkFile("//evil/share/a.txt")).toBeUndefined();
    expect(pickedNetworkFile(TAB)).toBeUndefined();
  });

  it.if(WINDOWS)("keeps no device path and no drive path", () => {
    freshStart();
    for (const file of [
      String.raw`\\?\UNC\nas\share\a.txt`,
      String.raw`\??\UNC\nas\share\a.txt`,
      String.raw`\\.\C:\a.txt`,
      "C:/a.txt",
    ]) {
      rememberPickedNetworkFile(file);
      expect(pickedNetworkFile(file)).toBeUndefined();
    }
  });

  it.if(WINDOWS)("holds only the latest picks that no tab shows yet", () => {
    freshStart();
    for (let i = 0; i <= MAX_PENDING_PICKS; i++)
      rememberPickedNetworkFile(`\\\\nas\\share\\${i}.txt`);
    expect(pickedNetworkFile("//nas/share/0.txt")).toBeUndefined();
    expect(pickedNetworkFile(`//nas/share/${MAX_PENDING_PICKS}.txt`)).toBeDefined();
  });

  it("keeps nothing on macOS or Linux", () => {
    if (WINDOWS) return;
    const saves = freshStart([PICKED], [TAB]);
    rememberPickedNetworkFile(PICKED);
    expect(pickedNetworkFile(TAB)).toBeUndefined();
    expect(saves).toEqual([[]]);
  });

  it("reads editor tab paths from every workspace layout", () => {
    const tab = (id: string, filePath: string) => ({
      id,
      type: "editor" as const,
      props: { filePath, workspaceId: "123e4567-e89b-12d3-a456-426614174000" },
    });
    const layouts = {
      a: { tabs: [tab("1", TAB), { id: "2", type: "terminal", props: { cwd: "C:/" } }] },
      b: { tabs: [tab("3", "C:/w/a.ts")] },
    } as unknown as AppState["layoutByWorkspace"];
    expect(editorTabFiles(layouts)).toEqual([TAB, "C:/w/a.ts"]);
    expect(editorTabFiles(undefined)).toEqual([]);
  });

  it("is never set by the renderer, but read back from the state file", () => {
    const parsed = ipcContract.appState.call.set.args.parse({ pickedNetworkFiles: [PICKED] });
    expect(parsed).not.toHaveProperty("pickedNetworkFiles");
    expect(AppStateSchema.parse({ pickedNetworkFiles: [PICKED] }).pickedNetworkFiles).toEqual([
      PICKED,
    ]);
    expect(AppStateSchema.parse({ pickedNetworkFiles: "x" }).pickedNetworkFiles).toBeUndefined();
  });
});

describe("registerPickedFileHandler", () => {
  const mainFrame = { routingId: 42 };
  const childFrame = { routingId: 43 };
  const event = (id: number, senderFrame: typeof mainFrame | null) =>
    ({ sender: { id, mainFrame }, senderFrame }) as unknown as IpcMainEvent;

  it("remembers a path only from an app window's main frame", () => {
    const on = mock((_channel: string, _listener: Parameters<IpcMain["on"]>[1]) => {});
    const remember = mock((_path: string) => {});
    registerPickedFileHandler({ on } as never, (sender) => sender.id === 1, remember);
    const [channel, listener] = on.mock.calls[0] ?? [];
    expect(channel).toBe(REMEMBER_PICKED_FILE);
    if (!listener) throw new Error("Expected a registered listener");

    listener(event(2, mainFrame), PICKED);
    listener(event(1, childFrame), PICKED);
    listener(event(1, null), PICKED);
    listener(event(1, mainFrame), { path: PICKED });
    expect(remember).not.toHaveBeenCalled();

    listener(event(1, mainFrame), PICKED);
    expect(remember.mock.calls).toEqual([[PICKED]]);
  });
});
