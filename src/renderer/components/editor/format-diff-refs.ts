// Diff ref display formatter.
//
// 탭 칩과 헤더 등에서 (leftRef, rightRef) 쌍을 짧게 표시할 때 쓰는 순수
// 포맷터. 출력 컨벤션은 git CLI의 `A..B`(예: `git diff HEAD..WORKING`)에
// 맞춰 사용자가 이미 가지고 있는 멘탈 모델을 재활용한다.

import { EMPTY_TREE } from "./diff-refs";

const SPECIAL_REFS: ReadonlySet<string> = new Set(["HEAD", "INDEX", "WORKING"]);
const SHA_LIKE_RE = /^[0-9a-f]{7,}$/i;

/**
 * Renders a single ref for compact tab display.
 *  - `EMPTY_TREE` sentinel → `∅` (unborn repo "before first commit").
 *  - `HEAD` / `INDEX` / `WORKING` → returned as-is (already short, semantic).
 *  - Hex SHA (7+ chars) → first 7 chars (git's default short-sha length).
 *  - Everything else (branch names, tags, `HEAD~1`, …) → returned as-is.
 */
export function formatDiffRef(ref: string): string {
  if (ref === EMPTY_TREE) return "∅";
  if (SPECIAL_REFS.has(ref)) return ref;
  if (SHA_LIKE_RE.test(ref)) return ref.slice(0, 7);
  return ref;
}

/**
 * Compact `left..right` suffix for diff tab labels. Mirrors git's
 * "two-dot range" notation so the suffix reads as natural diff vocabulary.
 */
export function formatDiffRefPair(leftRef: string, rightRef: string): string {
  return `${formatDiffRef(leftRef)}..${formatDiffRef(rightRef)}`;
}
