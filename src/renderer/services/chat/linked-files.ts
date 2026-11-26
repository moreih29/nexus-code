import i18next from "i18next";
import { useEffect, useMemo, useState } from "react";
import { isUnder } from "../../../shared/fs/relative-path";
import {
  type ChatFiles,
  type LinkedFile,
  type LinkFound,
  LinkGrantError,
  useChatFiles,
} from "./chat-files";
import { relativeLinkPath, resolveFilePath } from "./links";

export type LinkState = LinkFound | "failed";

const NONE: ReadonlyMap<string, LinkState> = new Map();

export function linkKey(link: LinkedFile): string {
  return JSON.stringify([link.href, link.source]);
}

export function pathInRoot(href: string, cwd: string, root: string): string | null {
  if (!root || relativeLinkPath(href, cwd) !== null) return null;
  const path = resolveFilePath(href, cwd);
  return path !== null && isUnder(path, root) ? path : null;
}

export function grantsOf(
  files: ChatFiles | null,
): files is ChatFiles & Required<Pick<ChatFiles, "resolve" | "open">> {
  return files?.resolve !== undefined && files.open !== undefined;
}

export function useLinksFound(
  links: readonly LinkedFile[] | null,
): ReadonlyMap<string, LinkState> | null {
  const files = useChatFiles();
  const grants = grantsOf(files) ? files : null;
  const scope = grants?.access?.scope ?? null;
  const key = useMemo(() => (links ? JSON.stringify(links.map(linkKey)) : ""), [links]);
  const [found, setFound] = useState<{
    scope: string | null;
    links: ReadonlyMap<string, LinkState>;
  }>(() => ({ scope, links: NONE }));
  if (found.scope !== scope) setFound({ scope, links: NONE });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `links`
  useEffect(() => {
    const signal = grants?.access?.signal;
    if (!grants || !links || links.length === 0 || !signal || signal.aborted) return;
    let live = true;
    void Promise.all(
      links.map((link) =>
        grants.resolve([link]).then(
          ([one]): [string, LinkState] => [linkKey(link), one ?? null],
          (): [string, LinkState] => [linkKey(link), "failed"],
        ),
      ),
    ).then((entries) => {
      if (!live || signal.aborted) return;
      setFound({ scope, links: new Map(entries) });
    });
    return () => {
      live = false;
    };
  }, [grants, scope, key]);
  if (!grants) return null;
  return found.scope === scope ? found.links : NONE;
}

export function grantMessage(error: unknown): string {
  const kind = error instanceof LinkGrantError ? error.kind : null;
  if (kind === "not-found") return String(i18next.t("chat.links.gone"));
  if (kind === "grant-invalid" || kind === "permission-denied") {
    return String(i18next.t("chat.links.denied"));
  }
  return String(i18next.t("chat.links.open_failed"));
}
