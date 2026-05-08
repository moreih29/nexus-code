import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkAndSearch } from "../../../../src/main/search/walker";
import type { FileMatch, TextSearchQuery } from "../../../../src/shared/types/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseQuery(overrides: Partial<TextSearchQuery> & { pattern: string }): TextSearchQuery {
  return {
    isRegExp: false,
    isCaseSensitive: false,
    isWordMatch: false,
    includes: [],
    excludes: [],
    maxResults: 2000,
    maxFileSize: 5 * 1024 * 1024,
    ...overrides,
  };
}

function noSignal(): AbortSignal {
  return new AbortController().signal;
}

function collectBatches(
  root: string,
  query: TextSearchQuery,
  signal?: AbortSignal,
): Promise<{ batches: FileMatch[][]; result: Awaited<ReturnType<typeof walkAndSearch>> }> {
  const batches: FileMatch[][] = [];
  return walkAndSearch(root, query, {
    signal: signal ?? noSignal(),
    onBatch: (b) => batches.push(b),
  }).then((result) => ({ batches, result }));
}

// ---------------------------------------------------------------------------
// Tmp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-walker-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic text search
// ---------------------------------------------------------------------------

describe("walker — basic text search", () => {
  test("finds a match in a plain text file", async () => {
    fs.writeFileSync(path.join(tmpRoot, "hello.ts"), "const greeting = 'hello world';\n");

    const { batches, result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));

    const allMatches = batches.flat();
    expect(allMatches.length).toBe(1);
    expect(allMatches[0].relPath).toBe("hello.ts");
    expect(result.matchesFound).toBe(1);
    // filesScanned counts every file whose content was inspected.
    expect(result.filesScanned).toBe(1);
  });

  test("filesScanned counts inspected files even when no match found", async () => {
    fs.writeFileSync(path.join(tmpRoot, "readme.md"), "# Project\nNo search term here.\n");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "zzz_notfound" }));
    expect(result.matchesFound).toBe(0);
    // The file was read and inspected — it counts.
    expect(result.filesScanned).toBe(1);
  });

  test("filesScanned === total text files inspected; matchesFound counts only hit lines", async () => {
    // 5 text files: 2 contain "needle", 3 do not.
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "needle here\nneedle again\n");
    fs.writeFileSync(path.join(tmpRoot, "b.ts"), "needle found\n");
    fs.writeFileSync(path.join(tmpRoot, "c.ts"), "no match\n");
    fs.writeFileSync(path.join(tmpRoot, "d.ts"), "nothing\n");
    fs.writeFileSync(path.join(tmpRoot, "e.ts"), "also nothing\n");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "needle" }));
    expect(result.filesScanned).toBe(5);
    expect(result.matchesFound).toBe(3); // 2 lines in a.ts + 1 in b.ts
  });
});

// ---------------------------------------------------------------------------
// HIDDEN_NAMES pruning
// ---------------------------------------------------------------------------

describe("walker — HIDDEN_NAMES pruning", () => {
  test("does not search inside .git", async () => {
    fs.mkdirSync(path.join(tmpRoot, ".git"));
    fs.writeFileSync(path.join(tmpRoot, ".git", "config"), "hello from git config");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(0);
  });

  test("does not search inside node_modules", async () => {
    fs.mkdirSync(path.join(tmpRoot, "node_modules"));
    fs.mkdirSync(path.join(tmpRoot, "node_modules", "some-pkg"));
    fs.writeFileSync(path.join(tmpRoot, "node_modules", "some-pkg", "index.js"), "hello");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEARCH_DEFAULT_EXCLUDES
// ---------------------------------------------------------------------------

describe("walker — SEARCH_DEFAULT_EXCLUDES file pruning", () => {
  test("skips *.min.js files", async () => {
    fs.writeFileSync(path.join(tmpRoot, "app.min.js"), "hello world minified");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(0);
  });

  test("skips *.map files", async () => {
    fs.writeFileSync(path.join(tmpRoot, "bundle.js.map"), "hello in a source map");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(0);
  });

  test("skips build/ directory", async () => {
    fs.mkdirSync(path.join(tmpRoot, "build"));
    fs.writeFileSync(path.join(tmpRoot, "build", "output.js"), "hello from build");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(0);
  });

  test("still finds match in a non-excluded file alongside excluded ones", async () => {
    fs.writeFileSync(path.join(tmpRoot, "app.min.js"), "hello minified");
    fs.writeFileSync(path.join(tmpRoot, "main.ts"), "hello source");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.matchesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Binary file skipping
// ---------------------------------------------------------------------------

describe("walker — binary file skipping", () => {
  test("skips binary files (NUL in first 512 bytes)", async () => {
    const buf = Buffer.alloc(100, 0x41);
    buf[10] = 0x00;
    fs.writeFileSync(path.join(tmpRoot, "binary.bin"), buf);

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "A" }));
    expect(result.matchesFound).toBe(0);
    // Binary files are not counted as scanned — they never reach the matcher.
    expect(result.filesScanned).toBe(0);
  });

  test("binary file does not contribute to filesScanned alongside a text file", async () => {
    const bin = Buffer.alloc(100, 0x41);
    bin[10] = 0x00;
    fs.writeFileSync(path.join(tmpRoot, "binary.bin"), bin);
    fs.writeFileSync(path.join(tmpRoot, "text.ts"), "hello\n");

    const { result } = await collectBatches(tmpRoot, baseQuery({ pattern: "hello" }));
    expect(result.filesScanned).toBe(1); // only text.ts
    expect(result.matchesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// filesScanned excludes oversize files
// ---------------------------------------------------------------------------

describe("walker — oversized files not counted in filesScanned", () => {
  test("oversize file is skipped and not counted as scanned", async () => {
    fs.writeFileSync(path.join(tmpRoot, "big.txt"), "hello world");
    fs.writeFileSync(path.join(tmpRoot, "small.ts"), "hello\n");

    const { result } = await collectBatches(
      tmpRoot,
      baseQuery({ pattern: "hello", maxFileSize: 5 }),
    );

    // big.txt (11 bytes) exceeds maxFileSize=5 — never reaches matcher.
    // small.ts (6 bytes) also exceeds 5, so neither is counted.
    expect(result.filesScanned).toBe(0);
    expect(result.matchesFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maxResults limit
// ---------------------------------------------------------------------------

describe("walker — maxResults limit", () => {
  test("limitHit=true and onBatch called when maxResults reached", async () => {
    // Write 20 files each containing one match; limit to 5
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tmpRoot, `file${i}.txt`), "target\n");
    }

    const { batches, result } = await collectBatches(
      tmpRoot,
      baseQuery({ pattern: "target", maxResults: 5 }),
    );

    expect(result.limitHit).toBe(true);
    expect(result.matchesFound).toBe(5);
    const total = batches.flat().reduce((s, fm) => s + fm.matches.length, 0);
    expect(total).toBe(5);
    expect(batches.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AbortController cancellation
// ---------------------------------------------------------------------------

describe("walker — AbortController cancellation", () => {
  test("pre-aborted signal exits quickly without throwing fatal", async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpRoot, `file${i}.ts`), "hello\n");
    }

    const ctrl = new AbortController();
    ctrl.abort();

    // Should not throw
    const batches: FileMatch[][] = [];
    const result = await walkAndSearch(tmpRoot, baseQuery({ pattern: "hello" }), {
      signal: ctrl.signal,
      onBatch: (b) => batches.push(b),
    });

    // limitHit is false for abort (not a result limit)
    expect(result.limitHit).toBe(false);
    // matchesFound reflects partial work (likely 0 since abort was pre-set)
  });

  test("abort mid-walk: total matches are consistent (no phantom results)", async () => {
    // Create 50 files
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(tmpRoot, `f${i}.ts`), "needle\n");
    }

    const ctrl = new AbortController();
    const batches: FileMatch[][] = [];
    let batchCount = 0;

    const resultP = walkAndSearch(tmpRoot, baseQuery({ pattern: "needle" }), {
      signal: ctrl.signal,
      onBatch: (b) => {
        batches.push(b);
        batchCount++;
        // Abort after the first batch arrives
        if (batchCount === 1) ctrl.abort();
      },
    });

    const result = await resultP;
    expect(result.limitHit).toBe(false);
    // matchesFound must equal total from all batches
    const batchTotal = batches.flat().reduce((s, fm) => s + fm.matches.length, 0);
    expect(result.matchesFound).toBe(batchTotal);
  });
});

// ---------------------------------------------------------------------------
// Batch flushing
// ---------------------------------------------------------------------------

describe("walker — batch flushing", () => {
  test("produces multiple onBatch calls when >50 files match", async () => {
    // Create 60 files each with one match
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmpRoot, `item${i}.txt`), "marker\n");
    }

    const { batches, result } = await collectBatches(tmpRoot, baseQuery({ pattern: "marker" }));

    expect(result.matchesFound).toBe(60);
    // With BATCH_COUNT_TRIGGER=50, we expect at least 2 batches
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Custom excludes
// ---------------------------------------------------------------------------

describe("walker — custom query.excludes", () => {
  test("skips files matching user-provided excludes", async () => {
    fs.writeFileSync(path.join(tmpRoot, "keep.ts"), "hello");
    fs.writeFileSync(path.join(tmpRoot, "skip.generated.ts"), "hello");

    const { result } = await collectBatches(
      tmpRoot,
      baseQuery({ pattern: "hello", excludes: ["*.generated.ts"] }),
    );

    expect(result.matchesFound).toBe(1);
  });

  test("skips directories matching user-provided dir excludes", async () => {
    fs.mkdirSync(path.join(tmpRoot, "vendor"));
    fs.writeFileSync(path.join(tmpRoot, "vendor", "lib.js"), "hello vendor");
    fs.writeFileSync(path.join(tmpRoot, "main.ts"), "hello main");

    const { result } = await collectBatches(
      tmpRoot,
      baseQuery({ pattern: "hello", excludes: ["vendor/"] }),
    );

    expect(result.matchesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Oversized file skipping
// ---------------------------------------------------------------------------

describe("walker — oversized file skipping", () => {
  test("skips files larger than maxFileSize", async () => {
    // Write 10 bytes into a file but set maxFileSize to 5
    fs.writeFileSync(path.join(tmpRoot, "big.txt"), "hello world");

    const { result } = await collectBatches(
      tmpRoot,
      baseQuery({ pattern: "hello", maxFileSize: 5 }),
    );

    expect(result.matchesFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Performance sanity (500-file walk should complete quickly)
// ---------------------------------------------------------------------------

describe("walker — performance sanity", () => {
  test("500-file tree completes in well under 5s", async () => {
    for (let i = 0; i < 500; i++) {
      fs.writeFileSync(path.join(tmpRoot, `file${i}.ts`), `const x${i} = ${i};\n`);
    }

    const start = Date.now();
    await collectBatches(tmpRoot, baseQuery({ pattern: "const" }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });
});
