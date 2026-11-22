import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

test("the built app state worker writes a replacement using its built dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nexus-built-state-"));
  const file = join(directory, "state.json");
  let worker;
  try {
    worker = new Worker(new URL("../../out/main/state-writer.js", import.meta.url), {
      workerData: file,
    });
    const signal = AbortSignal.timeout(10_000);
    assert.deepEqual(await once(worker, "message", { signal }), [{ ready: true }]);
    for (const width of [250, 270]) {
      worker.postMessage({
        kind: "write",
        state: { sidebarWidth: width },
        hasLayouts: false,
        gate: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      });
      assert.deepEqual(await once(worker, "message", { signal }), [{ written: true }]);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sidebarWidth: width });
    }
  } finally {
    await worker?.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});
