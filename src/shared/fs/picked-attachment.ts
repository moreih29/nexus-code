export const READ_PICKED_ATTACHMENT = "files:readPickedAttachment";

export function isWindowsLongPath(path: string | undefined): boolean {
  return path !== undefined && path.length >= 260;
}

export interface PickedAttachment {
  size: number;
  bytes: Uint8Array<ArrayBuffer> | null;
}
