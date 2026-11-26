import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";

export interface NavigatingFrame {
  readonly parent: NavigatingFrame | null;
}

export function allowsEmbeddedNavigation(url: string, initiator?: NavigatingFrame | null): boolean {
  if (initiator && initiator.parent !== null) return false;
  return url === "about:blank" || url.startsWith(`${PREVIEW_SCHEME}://`);
}
