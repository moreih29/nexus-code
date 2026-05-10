/**
 * Scenario tests for shared Git text stream chunking.
 */
import { describe, expect, test } from "bun:test";
import { chunkGitTextStream } from "../../../../src/main/git/git-diff-stream";

describe("chunkGitTextStream", () => {
  test("emits bounded text chunks at byte boundaries without losing UTF-8 text", async () => {
    const generator = chunkGitTextStream(
      buffers([Buffer.from("ab"), Buffer.from("cdef"), Buffer.from("€"), Buffer.from("gh")]),
      { maxChunkBytes: 3 },
    );

    const chunks: string[] = [];
    while (true) {
      const next = await generator.next();
      if (next.done) {
        expect(next.value).toEqual({ bytes: 11, truncated: false });
        break;
      }
      chunks.push(next.value.text);
    }

    expect(chunks).toEqual(["abc", "def", "€", "gh"]);
  });

  test("throws AbortError when the abort signal fires between chunks", async () => {
    const controller = new AbortController();
    const generator = chunkGitTextStream(abortingBuffers(controller), {
      signal: controller.signal,
      maxChunkBytes: 5,
    });

    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { text: "hello" },
    });
    await expect(generator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});

/** Creates an async buffer stream from in-memory chunks. */
async function* buffers(chunks: Buffer[]): AsyncGenerator<Buffer, void, unknown> {
  for (const chunk of chunks) yield chunk;
}

/** Aborts after the first chunk so the chunker sees cancellation mid-stream. */
async function* abortingBuffers(
  controller: AbortController,
): AsyncGenerator<Buffer, void, unknown> {
  yield Buffer.from("hello");
  controller.abort();
  yield Buffer.from("world");
}
