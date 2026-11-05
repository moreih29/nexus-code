// The encodings a file's text can be read and written in.
//
// The agent sends UTF-8 as text, and any other text as its bytes. Those
// are decoded here with the browser's TextDecoder: in UTF-16 when they
// start with its byte-order mark, else in the first encoding of the
// user's languages they are valid in (Korean: EUC-KR; Japanese: Shift_JIS,
// EUC-JP; Chinese: GBK, Big5), else as Western (Windows-1252), which
// takes any bytes. The user can reopen the file in another.
//
// Writing goes back the same way. The browser has no encoder but UTF-8's,
// so each encoding's is built from its decoder: every byte, and every
// pair of bytes for the double-byte ones, decoded once, to the character
// it is. A character the encoding has no bytes for cannot be saved in it.

/** An encoding a file is read and written in. */
export type TextEncoding = (typeof TEXT_ENCODINGS)[number]["id"];

export interface TextEncodingInfo {
  /** As files store it; the TextDecoder label, but for the two UTF-8s. */
  readonly id: string;
  /** Its name, as menus show it. */
  readonly name: string;
  /** The language or script it is for, an i18n key under `encoding.group`. */
  readonly group: string;
  /** Bytes per character: one, or one or two. */
  readonly width: "single" | "double" | "utf";
}

export const TEXT_ENCODINGS = [
  { id: "utf8", name: "UTF-8", group: "unicode", width: "utf" },
  { id: "utf8-bom", name: "UTF-8 with BOM", group: "unicode", width: "utf" },
  { id: "utf-16le", name: "UTF-16 LE", group: "unicode", width: "utf" },
  { id: "utf-16be", name: "UTF-16 BE", group: "unicode", width: "utf" },
  { id: "euc-kr", name: "EUC-KR (CP949)", group: "korean", width: "double" },
  { id: "shift_jis", name: "Shift_JIS", group: "japanese", width: "double" },
  { id: "euc-jp", name: "EUC-JP", group: "japanese", width: "double" },
  { id: "gbk", name: "GBK", group: "chineseSimplified", width: "double" },
  { id: "big5", name: "Big5", group: "chineseTraditional", width: "double" },
  { id: "windows-1252", name: "Windows-1252", group: "western", width: "single" },
  { id: "iso-8859-15", name: "ISO-8859-15", group: "western", width: "single" },
  { id: "windows-1250", name: "Windows-1250", group: "centralEuropean", width: "single" },
  { id: "iso-8859-2", name: "ISO-8859-2", group: "centralEuropean", width: "single" },
  { id: "windows-1251", name: "Windows-1251", group: "cyrillic", width: "single" },
  { id: "koi8-r", name: "KOI8-R", group: "cyrillic", width: "single" },
  { id: "windows-1253", name: "Windows-1253", group: "greek", width: "single" },
  { id: "windows-1254", name: "Windows-1254", group: "turkish", width: "single" },
  { id: "windows-1255", name: "Windows-1255", group: "hebrew", width: "single" },
  { id: "windows-1256", name: "Windows-1256", group: "arabic", width: "single" },
  { id: "windows-1257", name: "Windows-1257", group: "baltic", width: "single" },
  { id: "windows-1258", name: "Windows-1258", group: "vietnamese", width: "single" },
  { id: "windows-874", name: "Windows-874", group: "thai", width: "single" },
] as const satisfies readonly TextEncodingInfo[];

export function isTextEncoding(value: string): value is TextEncoding {
  return TEXT_ENCODINGS.some((encoding) => encoding.id === value);
}

export function encodingInfo(id: TextEncoding): TextEncodingInfo {
  return TEXT_ENCODINGS.find((encoding) => encoding.id === id) as TextEncodingInfo;
}

/** Encodings tried, in turn, for a user of each language, before Windows-1252. */
const BY_LANGUAGE: Record<string, readonly TextEncoding[]> = {
  ko: ["euc-kr"],
  ja: ["shift_jis", "euc-jp"],
  zh: ["gbk", "big5"],
  "zh-tw": ["big5", "gbk"],
  "zh-hk": ["big5", "gbk"],
  "zh-hant": ["big5", "gbk"],
};

/** The encodings to try for bytes not in UTF-8, the user's languages first. */
export function encodingsToTry(languages: readonly string[]): TextEncoding[] {
  const order: TextEncoding[] = [];
  for (const language of languages) {
    const lower = language.toLowerCase();
    const found = BY_LANGUAGE[lower] ?? BY_LANGUAGE[lower.split("-")[0] ?? ""] ?? [];
    for (const encoding of found) if (!order.includes(encoding)) order.push(encoding);
  }
  return order;
}

function decoderLabel(id: TextEncoding): string {
  return id === "utf8" || id === "utf8-bom" ? "utf-8" : id;
}

/** `bytes` decoded in `encoding`, with U+FFFD for bytes not valid in it. */
export function decodeBytes(bytes: Uint8Array, encoding: TextEncoding): string {
  // TextDecoder drops a byte-order mark that matches its encoding.
  return new TextDecoder(decoderLabel(encoding)).decode(bytes);
}

/**
 * The encoding `bytes` most likely are in: UTF-16 by its byte-order mark,
 * else the first of `candidates` they are valid in, else Windows-1252.
 */
export function guessEncoding(
  bytes: Uint8Array,
  candidates: readonly TextEncoding[],
): TextEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  for (const candidate of candidates) {
    try {
      new TextDecoder(decoderLabel(candidate), { fatal: true }).decode(bytes);
      return candidate;
    } catch {
      // Not valid in it: the next.
    }
  }
  return "windows-1252";
}

/** Each character an encoding has bytes for, to its bytes. */
type EncodeTable = Map<number, Uint8Array>;

const tables = new Map<TextEncoding, EncodeTable>();

/** The lead bytes to read in turn: where two pairs read as one character, the first is kept. */
function leadBytes(encoding: TextEncoding): number[] {
  const leads: number[] = [];
  for (let b = 0x81; b <= 0xfe; b++) leads.push(b);
  // Big5's leads below 0xA1 are Hong Kong additions, some of which repeat
  // standard characters; Shift_JIS's 0xED and 0xEE repeat IBM's 0xFA–0xFC.
  // The standard places come first, as the WHATWG encoders choose them.
  if (encoding === "big5")
    return [...leads.filter((b) => b >= 0xa1), ...leads.filter((b) => b < 0xa1)];
  if (encoding === "shift_jis") {
    return [...leads.filter((b) => b !== 0xed && b !== 0xee), 0xed, 0xee];
  }
  return leads;
}

function buildTable(encoding: TextEncoding): EncodeTable {
  const decoder = new TextDecoder(decoderLabel(encoding), { fatal: true });
  const table: EncodeTable = new Map();
  const add = (bytes: number[]) => {
    let text: string;
    try {
      text = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    const code = text.codePointAt(0);
    if (code === undefined || String.fromCodePoint(code) !== text || table.has(code)) return;
    table.set(code, Uint8Array.from(bytes));
  };
  for (let b = 0; b < 0x80; b++) table.set(b, Uint8Array.of(b));
  for (let b = 0x80; b <= 0xff; b++) add([b]);
  if (encodingInfo(encoding).width === "double") {
    for (const lead of leadBytes(encoding)) {
      for (let trail = 0x40; trail <= 0xfe; trail++) add([lead, trail]);
    }
  }
  return table;
}

function tableFor(encoding: TextEncoding): EncodeTable {
  let table = tables.get(encoding);
  if (!table) {
    table = buildTable(encoding);
    tables.set(encoding, table);
  }
  return table;
}

/** A character an encoding has no bytes for, and where it is. */
export interface Unencodable {
  readonly char: string;
  /** Its line and column, from 1. */
  readonly line: number;
  readonly column: number;
}

export type EncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly unencodable: Unencodable };

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

/** `text` in `encoding`, as a file stores it: UTF-16 with its byte-order mark. */
export function encodeText(text: string, encoding: TextEncoding): EncodeResult {
  if (encoding === "utf8") return { ok: true, bytes: new TextEncoder().encode(text) };
  if (encoding === "utf8-bom") return { ok: true, bytes: new TextEncoder().encode(`﻿${text}`) };
  if (encoding === "utf-16le") return { ok: true, bytes: utf16(text, true) };
  if (encoding === "utf-16be") return { ok: true, bytes: utf16(text, false) };

  const table = tableFor(encoding);
  const parts: Uint8Array[] = [];
  let length = 0;
  let line = 1;
  let column = 1;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const bytes = table.get(code);
    if (!bytes) return { ok: false, unencodable: { char, line, column } };
    parts.push(bytes);
    length += bytes.length;
    if (char === "\n") {
      line++;
      column = 1;
    } else {
      column += char.length;
    }
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { ok: true, bytes: out };
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
