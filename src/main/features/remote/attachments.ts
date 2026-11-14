/**
 * The images another device sends a chat ahead of its message
 * (chat.attach), kept until chat.send names them: one request carries one
 * image, so a message with several takes several. Each is kept for the
 * device that sent it and the tab it was for, ATTACHMENT_TTL_MS at most,
 * and goes once the message it was attached to is sent.
 */
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, RpcErrorCode } from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

/** How long an image waits for the message it was sent for. */
export const ATTACHMENT_TTL_MS = 10 * 60_000;

/** Most images one device may have waiting: more than a few messages' worth is no message. */
export const MAX_KEPT_PER_DEVICE = 16;

export interface Attached {
  mediaType: string;
  /** Base64. */
  data: string;
}

interface Kept extends Attached {
  id: string;
  device: string;
  workspaceId: string;
  tabId: string;
  at: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether the bytes begin as an image of that type does. */
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

  /** Keeps an image for the device's next message to the tab; its id. */
  take(device: string, workspaceId: string, tabId: string, image: Attached): string {
    if (!BASE64.test(image.data)) throw invalid("the image is not base64");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw invalid(`the image takes over ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    if (!looksLike(image.mediaType, bytes)) {
      throw invalid(`the image is not the ${image.mediaType} it says it is`);
    }
    this.sweep();
    const mine = this.kept.filter((k) => k.device === device);
    if (mine.length >= MAX_KEPT_PER_DEVICE) {
      const oldest = mine[0];
      this.kept = this.kept.filter((k) => k !== oldest);
    }
    const id = randomUUID();
    this.kept.push({ id, device, workspaceId, tabId, at: this.now(), ...image });
    return id;
  }

  /** The images the device kept for the tab, in the order named; refuses any it does not hold. */
  find(device: string, workspaceId: string, tabId: string, ids: readonly string[]): Attached[] {
    this.sweep();
    return ids.map((id) => {
      const kept = this.kept.find((k) => k.id === id);
      if (!kept || kept.device !== device) {
        throw invalid(`no image ${id} is waiting: chat.attach keeps one for 10 minutes`);
      }
      if (kept.workspaceId !== workspaceId || kept.tabId !== tabId) {
        throw invalid(`the image ${id} was attached for another chat`);
      }
      return { mediaType: kept.mediaType, data: kept.data };
    });
  }

  /** The message they were for is sent: they go. */
  drop(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.kept = this.kept.filter((k) => !gone.has(k.id));
  }

  private sweep(): void {
    const now = this.now();
    this.kept = this.kept.filter((k) => now - k.at < ATTACHMENT_TTL_MS);
  }
}
