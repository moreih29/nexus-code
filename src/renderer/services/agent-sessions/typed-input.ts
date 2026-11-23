const CHUNK_CHARS = 64;

export const ECHO_WAIT_MS = 1000;

const CHUNK_GAP_MS = 10;

export const NEWLINE_KEY = "\n";

export function typedChunks(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is removed
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .split("\n");
  const chunks: string[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(NEWLINE_KEY);
    const chars = Array.from(line);
    for (let start = 0; start < chars.length; start += CHUNK_CHARS) {
      chunks.push(chars.slice(start, start + CHUNK_CHARS).join(""));
    }
  });
  return chunks;
}

export interface TypingTarget {
  write(text: string): void;
  nextOutput(timeoutMs: number): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function typeText(target: TypingTarget, text: string): Promise<void> {
  for (const chunk of typedChunks(text)) {
    const shown = target.nextOutput(ECHO_WAIT_MS);
    target.write(chunk);
    await shown;
    await sleep(CHUNK_GAP_MS);
  }
}
