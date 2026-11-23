export interface ConflictSection {
  startLine: number;
  endLine: number;
}

export interface ConflictBlock {
  index: number;
  blockRange: ConflictSection;
  currentMarkerLine: number;
  current: ConflictSection;
  base: ConflictSection | null;
  baseMarkerLine: number | null;
  separatorLine: number;
  incoming: ConflictSection;
  incomingMarkerLine: number;
}

const CURRENT_RE = /^<{7}( |$)/;
const BASE_RE = /^\|{7}( |$)/;
const SEPARATOR_RE = /^={7}$/;
const INCOMING_RE = /^>{7}( |$)/;

export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const blocks: ConflictBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !CURRENT_RE.test(line)) {
      i++;
      continue;
    }

    const block = parseBlock(lines, i);
    if (block !== null) {
      blocks.push({ ...block, index: blocks.length });
      i = block.incomingMarkerLine;
    } else {
      i++;
    }
  }

  return blocks;
}

function parseBlock(
  lines: readonly string[],
  startIdx: number,
): Omit<ConflictBlock, "index"> | null {
  const currentMarkerLine = startIdx + 1;

  let baseMarkerLine: number | null = null;
  let separatorLine: number | null = null;
  let incomingMarkerLine: number | null = null;

  for (let j = startIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l) continue;

    if (CURRENT_RE.test(l)) {
      return null;
    }

    if (BASE_RE.test(l) && baseMarkerLine === null && separatorLine === null) {
      baseMarkerLine = j + 1;
      continue;
    }

    if (SEPARATOR_RE.test(l) && separatorLine === null) {
      separatorLine = j + 1;
      continue;
    }

    if (INCOMING_RE.test(l) && separatorLine !== null) {
      incomingMarkerLine = j + 1;
      break;
    }
  }

  if (separatorLine === null || incomingMarkerLine === null) {
    return null;
  }

  const current: ConflictSection = {
    startLine: currentMarkerLine + 1,
    endLine: (baseMarkerLine ?? separatorLine) - 1,
  };

  const base: ConflictSection | null =
    baseMarkerLine !== null ? { startLine: baseMarkerLine + 1, endLine: separatorLine - 1 } : null;

  const incoming: ConflictSection = {
    startLine: separatorLine + 1,
    endLine: incomingMarkerLine - 1,
  };

  return {
    blockRange: { startLine: currentMarkerLine, endLine: incomingMarkerLine },
    currentMarkerLine,
    current,
    base,
    baseMarkerLine,
    separatorLine,
    incoming,
    incomingMarkerLine,
  };
}

export function hasConflictMarkers(text: string): boolean {
  return CURRENT_RE.test(text) || text.includes("\n<<<<<<<");
}

export function acceptCurrent(text: string, block: ConflictBlock): string {
  return replaceBlock(text, block, linesForSection(text, block.current));
}

export function acceptIncoming(text: string, block: ConflictBlock): string {
  return replaceBlock(text, block, linesForSection(text, block.incoming));
}

export function acceptBoth(text: string, block: ConflictBlock): string {
  const currentLines = linesForSection(text, block.current);
  const incomingLines = linesForSection(text, block.incoming);
  return replaceBlock(text, block, [...currentLines, ...incomingLines]);
}

function linesForSection(text: string, section: ConflictSection): string[] {
  const lines = text.split("\n");
  return lines.slice(section.startLine - 1, section.endLine);
}

function replaceBlock(text: string, block: ConflictBlock, replacementLines: string[]): string {
  const lines = text.split("\n");
  const blockStart = block.blockRange.startLine - 1;
  const blockEnd = block.blockRange.endLine - 1;
  const before = lines.slice(0, blockStart);
  const after = lines.slice(blockEnd + 1);
  return [...before, ...replacementLines, ...after].join("\n");
}
