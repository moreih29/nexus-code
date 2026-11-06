// Line breaks within a paragraph of a slide's text (a:br), which
// pptxtojson reads as spaces. The file is given to it with each break as a
// run of a character of its own, which the slide's text then breaks at.
// Kept apart from pptx.ts so that only the preview loads the unzipping.

import { strFromU8, strToU8, type Unzipped, unzipSync, zipSync } from "fflate";

/**
 * What a line break within a paragraph (a:br) is given to pptxtojson as,
 * which reads the break itself as a space: a run of this character, a
 * Unicode noncharacter no file holds, where the slide then breaks the line.
 */
export const LINE_BREAK = "\uFDD0";

/** The parts whose text is drawn: slides, their layouts and masters, and notes. */
const TEXT_PART = /^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/;

/** A line break, empty or holding the run properties of the line it ends. */
const BREAK = /<a:br\s*\/>|<a:br(?:\s[^>]*)?>([\s\S]*?)<\/a:br>/g;

/** A part's XML with each line break written as a run of LINE_BREAK, in the break's properties. */
export function breaksToRuns(xml: string): string {
  return xml.replace(
    BREAK,
    (_whole, props: string | undefined) => `<a:r>${props ?? ""}<a:t>${LINE_BREAK}</a:t></a:r>`,
  );
}

/**
 * The file for pptxtojson, its line breaks as runs it keeps: the same
 * bytes when it has none, or is not a zip, which pptxtojson then reports.
 */
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
  // Stored rather than compressed: it is read once, right away.
  return zipSync(files, { level: 0 });
}
