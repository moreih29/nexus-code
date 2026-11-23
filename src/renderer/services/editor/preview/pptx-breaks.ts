import { strFromU8, strToU8, type Unzipped, unzipSync, zipSync } from "fflate";

export const LINE_BREAK = "\uFDD0";

const TEXT_PART = /^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/;

const BREAK = /<a:br\s*\/>|<a:br(?:\s[^>]*)?>([\s\S]*?)<\/a:br>/g;

export function breaksToRuns(xml: string): string {
  return xml.replace(
    BREAK,
    (_whole, props: string | undefined) => `<a:r>${props ?? ""}<a:t>${LINE_BREAK}</a:t></a:r>`,
  );
}

export function withLineBreaks(bytes: Uint8Array): Uint8Array {
  let text: Unzipped;
  try {
    text = unzipSync(bytes, { filter: (file) => TEXT_PART.test(file.name) });
  } catch {
    return bytes;
  }
  const broken = Object.entries(text).filter(([, data]) => strFromU8(data).includes("<a:br"));
  if (broken.length === 0) return bytes;
  const files = unzipSync(bytes, { filter: (file) => !TEXT_PART.test(file.name) });
  for (const [name, data] of Object.entries(text)) files[name] = data;
  for (const [name, data] of broken) files[name] = strToU8(breaksToRuns(strFromU8(data)));
  return zipSync(files, { level: 0 });
}
