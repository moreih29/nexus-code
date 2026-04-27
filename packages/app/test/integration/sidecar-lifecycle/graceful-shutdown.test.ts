import { beforeAll, describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SidecarStartCommand } from "../../../../shared/src/contracts/sidecar/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { SidecarBridge } from "../../../src/main/sidecar-bridge";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const sidecarDir = join(repoRoot, "sidecar");
const sidecarBin = join(sidecarDir, "bin", process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar");

beforeAll(() => {
  mkdirSync(join(sidecarDir, "bin"), { recursive: true });
  const result = spawnSync("go", ["build", "-o", sidecarBin, "./cmd/nexus-sidecar"], { cwd: sidecarDir, encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

describe("sidecar graceful shutdown measurement", () => {
  test("SidecarBridge.stop() close handshake 10회 평균이 500ms 미만이다", async () => {
    const samples: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const workspaceId = `ws_graceful_${Date.now()}_${index}` as WorkspaceId;
      const bridge = new SidecarBridge({ sidecarBin, reconcileWindowMs: 20 });
      await bridge.start(startCommand(workspaceId));

      const startedAt = performance.now();
      const stopped = await bridge.stop({ type: "sidecar/stop", workspaceId, reason: "workspace-close" });
      samples.push(performance.now() - startedAt);
      expect(stopped).toMatchObject({ reason: "requested", exitCode: 0 });
    }

    samples.sort((a, b) => a - b);
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const max = samples.at(-1)!;
    console.info(`graceful-shutdown-ms avg=${average.toFixed(1)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${max.toFixed(1)}`);
    expect(average).toBeLessThan(500);
  }, 30_000);
});

function startCommand(workspaceId: WorkspaceId): SidecarStartCommand {
  return { type: "sidecar/start", workspaceId, workspacePath: repoRoot, reason: "workspace-open" };
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}
