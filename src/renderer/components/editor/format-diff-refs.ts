import { EMPTY_TREE } from "./diff-refs";

const SPECIAL_REFS: ReadonlySet<string> = new Set(["HEAD", "INDEX", "WORKING"]);
const SHA_LIKE_RE = /^[0-9a-f]{7,}$/i;

export function formatDiffRef(ref: string): string {
  if (ref === EMPTY_TREE) return "∅";
  if (SPECIAL_REFS.has(ref)) return ref;
  if (SHA_LIKE_RE.test(ref)) return ref.slice(0, 7);
  return ref;
}

export function formatDiffRefPair(leftRef: string, rightRef: string): string {
  return `${formatDiffRef(leftRef)}..${formatDiffRef(rightRef)}`;
}
