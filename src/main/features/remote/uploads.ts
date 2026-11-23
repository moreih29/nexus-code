import { randomUUID } from "node:crypto";
import {
  MAX_BYTES_CHUNK,
  MAX_UPLOAD_BYTES,
  RpcErrorCode,
} from "../../../../packages/remote-protocol/src";
import { ATTACHMENT_TTL_MS, type Attachments, looksLike } from "./attachments";
import { RpcFailure } from "./room";

export const MAX_UPLOADS_PER_DEVICE = 2;

export const MAX_UPLOAD_IMAGE_BYTES = 3_750_000;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

interface Upload {
  id: string;
  device: string;
  workspaceId: string;
  tabId: string;
  name: string;
  size: number;
  mediaType?: string;
  pieces: Buffer[];
  received: number;
  at: number;
}

function invalid(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.InvalidParams, message);
}

export function badName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return "the file needs a name";
  if (/[/\\]/.test(name)) return "the file's name may not hold a folder";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  if (/[\u0000-\u001f\u007f]/.test(name)) return "the file's name may not hold control characters";
  return null;
}

function imageTypeOf(bytes: Buffer, mediaType: string | undefined): string | null {
  const said = IMAGE_TYPES.find((t) => t === mediaType);
  if (said) return looksLike(said, bytes) ? said : null;
  return IMAGE_TYPES.find((t) => looksLike(t, bytes)) ?? null;
}

type Schedule = (run: () => void, ms: number) => () => void;

const scheduleSweep: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class Uploads {
  private uploads: Upload[] = [];
  private cancelSweep: (() => void) | null = null;

  constructor(
    private readonly attachments: Attachments,
    private readonly now: () => number = Date.now,
    private readonly schedule: Schedule = scheduleSweep,
  ) {}

  begin(
    device: string,
    workspaceId: string,
    tabId: string,
    file: { name: string; size: number; mediaType?: string },
  ): string {
    const bad = badName(file.name);
    if (bad) throw invalid(bad);
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      throw invalid(`a file takes 1 to ${MAX_UPLOAD_BYTES} bytes`);
    }
    this.sweep();
    const mine = this.uploads.filter((u) => u.device === device);
    if (mine.length >= MAX_UPLOADS_PER_DEVICE) {
      const oldest = mine[0];
      this.uploads = this.uploads.filter((u) => u !== oldest);
    }
    const id = randomUUID();
    this.uploads.push({
      id,
      device,
      workspaceId,
      tabId,
      name: file.name.trim(),
      size: file.size,
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      pieces: [],
      received: 0,
      at: this.now(),
    });
    this.armSweep();
    return id;
  }

  chunk(device: string, uploadId: string, offset: number, data: string): void {
    const upload = this.mine(device, uploadId);
    const refuse = (message: string): never => {
      this.drop(upload);
      throw invalid(message);
    };
    if (offset !== upload.received) {
      refuse(`pieces go in order: the next starts at ${upload.received}, not ${offset}`);
    }
    if (!BASE64.test(data)) refuse("the piece is not base64");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) refuse("the piece is empty");
    if (bytes.length > MAX_BYTES_CHUNK) refuse(`a piece takes at most ${MAX_BYTES_CHUNK} bytes`);
    if (upload.received + bytes.length > upload.size) {
      refuse(`the file was to take ${upload.size} bytes`);
    }
    upload.pieces.push(bytes);
    upload.received += bytes.length;
    upload.at = this.now();
  }

  end(device: string, uploadId: string): string {
    const upload = this.mine(device, uploadId);
    this.drop(upload);
    if (upload.received !== upload.size) {
      throw invalid(`the file was to take ${upload.size} bytes, and ${upload.received} came`);
    }
    const bytes = Buffer.concat(upload.pieces);
    const image =
      bytes.length <= MAX_UPLOAD_IMAGE_BYTES ? imageTypeOf(bytes, upload.mediaType) : null;
    const { workspaceId, tabId } = upload;
    return this.attachments.hold(
      device,
      workspaceId,
      tabId,
      image
        ? { kind: "image", mediaType: image, data: bytes.toString("base64") }
        : { kind: "file", name: upload.name, data: bytes.toString("base64") },
      bytes.length,
    );
  }

  private mine(device: string, uploadId: string): Upload {
    this.sweep();
    const upload = this.uploads.find((u) => u.id === uploadId);
    if (!upload || upload.device !== device) {
      throw invalid(`no upload ${uploadId} is under way: one is dropped after 10 minutes idle`);
    }
    return upload;
  }

  private drop(upload: Upload): void {
    this.uploads = this.uploads.filter((u) => u !== upload);
    this.armSweep();
  }

  private sweep(): void {
    const now = this.now();
    this.uploads = this.uploads.filter((u) => now - u.at < ATTACHMENT_TTL_MS);
    this.armSweep();
  }

  private armSweep(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    if (this.uploads.length === 0) return;
    const idleSince = Math.min(...this.uploads.map((u) => u.at));
    this.cancelSweep = this.schedule(
      () => {
        this.cancelSweep = null;
        this.sweep();
      },
      Math.max(1, idleSince + ATTACHMENT_TTL_MS - this.now()),
    );
  }
}
