import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, RpcErrorCode } from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

export const ATTACHMENT_TTL_MS = 10 * 60_000;

export const MAX_KEPT_PER_DEVICE = 16;

export const MAX_KEPT_BYTES_PER_DEVICE = 64 * 1024 * 1024;

export interface Attached {
  mediaType: string;
  data: string;
}

export type Held =
  | ({ kind: "image" } & Attached)
  | {
      kind: "file";
      name: string;
      data: string;
    };

type Kept = Held & {
  id: string;
  device: string;
  workspaceId: string;
  tabId: string;
  at: number;
  bytes: number;
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function looksLike(mediaType: string, bytes: Buffer): boolean {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  switch (mediaType) {
    case "image/png":
      return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case "image/jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/gif":
      return ascii(0, 4) === "GIF8";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    default:
      return false;
  }
}

function invalid(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.InvalidParams, message);
}

export class Attachments {
  private kept: Kept[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  take(device: string, workspaceId: string, tabId: string, image: Attached): string {
    if (!BASE64.test(image.data)) throw invalid("the image is not base64");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw invalid(`the image takes over ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    if (!looksLike(image.mediaType, bytes)) {
      throw invalid(`the image is not the ${image.mediaType} it says it is`);
    }
    return this.hold(device, workspaceId, tabId, { kind: "image", ...image }, bytes.length);
  }

  hold(device: string, workspaceId: string, tabId: string, held: Held, bytes: number): string {
    this.sweep();
    let mine = this.kept.filter((k) => k.device === device);
    while (
      mine.length > 0 &&
      (mine.length >= MAX_KEPT_PER_DEVICE ||
        mine.reduce((sum, k) => sum + k.bytes, 0) + bytes > MAX_KEPT_BYTES_PER_DEVICE)
    ) {
      const oldest = mine[0];
      this.kept = this.kept.filter((k) => k !== oldest);
      mine = mine.slice(1);
    }
    const id = randomUUID();
    this.kept.push({ ...held, id, device, workspaceId, tabId, at: this.now(), bytes });
    return id;
  }

  find(device: string, workspaceId: string, tabId: string, ids: readonly string[]): Held[] {
    this.sweep();
    return ids.map((id) => {
      const kept = this.kept.find((k) => k.id === id);
      if (!kept || kept.device !== device) {
        throw invalid(
          `no image or file ${id} is waiting: chat.attach and chat.upload keep one for 10 minutes`,
        );
      }
      if (kept.workspaceId !== workspaceId || kept.tabId !== tabId) {
        throw invalid(`the attachment ${id} was for another chat`);
      }
      return kept.kind === "image"
        ? { kind: "image", mediaType: kept.mediaType, data: kept.data }
        : { kind: "file", name: kept.name, data: kept.data };
    });
  }

  drop(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.kept = this.kept.filter((k) => !gone.has(k.id));
  }

  private sweep(): void {
    const now = this.now();
    this.kept = this.kept.filter((k) => now - k.at < ATTACHMENT_TTL_MS);
  }
}
