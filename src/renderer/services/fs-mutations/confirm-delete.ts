/**
 * confirmAndDeletePath — 파일/디렉터리 삭제 공통 helper.
 *
 * window.confirm 로 사용자 확인 후 nodeType에 따라 unlinkPath / rmdirPath
 * 를 분기 호출한다. 컨텍스트 메뉴(use-file-tree-actions)와 글로벌 키바인딩
 * 핸들러(file.delete command) 두 곳이 이 함수를 통해 동일한 경로를 밟는다.
 *
 * CRITICAL — 이 함수는 루트 경로 guard 를 포함하지 않는다.
 * 호출 측(use-file-tree-actions: isRoot check, 글로벌 핸들러: rootAbsPath 비교)
 * 에서 isRoot / 루트 판별 후 호출해야 한다.
 */

import { basename } from "@/utils/path";
import { rmdirPath } from "./rmdir";
import { unlinkPath } from "./unlink";

/**
 * @param workspaceId    현재 워크스페이스 ID.
 * @param workspaceRootPath   워크스페이스 루트 절대 경로.
 * @param absPath        삭제 대상 절대 경로.
 * @param nodeType       "file" | "dir" | "symlink"
 * @param name           confirm 다이얼로그용 이름 (기본값: basename(absPath)).
 * @returns              삭제 성공 시 true, confirm 취소 또는 IPC 실패 시 false.
 */
export async function confirmAndDeletePath(
  workspaceId: string,
  workspaceRootPath: string,
  absPath: string,
  nodeType: "file" | "dir" | "symlink",
  name?: string,
): Promise<boolean> {
  const displayName = name ?? basename(absPath);
  const kindLabel = nodeType === "dir" ? "folder" : "file";

  // window.confirm 을 직접 참조하지 않고 globalThis 경유로 접근해
  // Electron / jsdom / bun:test 환경 모두에서 동일하게 동작한다.
  const confirmFn = globalThis.window?.confirm ?? (globalThis as { confirm?: typeof window.confirm }).confirm;
  if (typeof confirmFn === "function") {
    const ok = confirmFn(`Delete ${kindLabel} "${displayName}"?`);
    if (!ok) return false;
  }

  if (nodeType === "dir") {
    return rmdirPath({ workspaceId, workspaceRootPath, absPath });
  }
  return unlinkPath({ workspaceId, workspaceRootPath, absPath });
}
