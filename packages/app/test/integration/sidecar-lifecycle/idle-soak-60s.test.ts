import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SidecarStartCommand } from "../../../../shared/src/contracts/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import { SidecarBridge } from "../../../src/main/sidecar-bridge";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const sidecarDir = join(repoRoot, "sidecar");
const sidecarBin = join(sidecarDir, "bin", process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar");

beforeAll(() => {
  mkdirSync(join(sidecarDir, "bin"), { recursive: true });
  const result = spawnSync("go", ["build", "-o", sidecarBin, "./cmd/nexus-sidecar"], { cwd: sidecarDir, encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

describe("sidecar 60s idle soak", () => {
  test("heartbeat 4회 이상과 메모리 누수 시그널 부재를 확인한다", async () => {
    const durationMs = Number(process.env.SIDECAR_SOAK_DURATION_MS ?? 63_000);
    const heapLimitBytes = process.env.SIDECAR_SOAK_HEAP_DELTA_LIMIT_BYTES
      ? Number(process.env.SIDECAR_SOAK_HEAP_DELTA_LIMIT_BYTES)
      : null;
    const workspaceId = `ws_idle_soak_${Date.now()}` as WorkspaceId;
    const bridge = new SidecarBridge({ sidecarBin });
    await bridge.start(startCommand(workspaceId));
    const record = recordOf(bridge, workspaceId);
    const originalPing = record.ws.ping.bind(record.ws);
    let pingCount = 0;
    record.ws.ping = (...args: unknown[]) => {
      pingCount += 1;
      return originalPing(...args as []);
    };

    const before = process.memoryUsage();
    const heapSamples = [before.heapUsed];
    const sampleTimer = setInterval(() => heapSamples.push(process.memoryUsage().heapUsed), 15_000);
    await delay(durationMs);
    clearInterval(sampleTimer);
    const after = process.memoryUsage();
    heapSamples.push(after.heapUsed);
    const rssDelta = after.rss - before.rss;
    const heapDelta = after.heapUsed - before.heapUsed;
    console.info(`idle-soak durationMs=${durationMs} pingCount=${pingCount} rssDelta=${rssDelta} heapUsedDelta=${heapDelta} heapSamples=${heapSamples.join(",")}`);

    await bridge.stop({ type: "sidecar/stop", workspaceId, reason: "workspace-close" });

    expect(pingCount).toBeGreaterThanOrEqual(Math.floor(durationMs / 15_000));
    expect(isStrictlyIncreasing(heapSamples)).toBe(false);
    if (heapLimitBytes !== null) {
      expect(heapDelta).toBeLessThan(heapLimitBytes);
    }
  }, Number(process.env.SIDECAR_SOAK_DURATION_MS ?? 63_000) + 15_000);
});

type BridgeRecord = { ws: { ping: (...args: unknown[]) => unknown } };

function startCommand(workspaceId: WorkspaceId): SidecarStartCommand {
  return { type: "sidecar/start", workspaceId, workspacePath: repoRoot, reason: "workspace-open" };
}

function recordOf(bridge: SidecarBridge, workspaceId: WorkspaceId): BridgeRecord {
  const records = (bridge as unknown as { recordsByWorkspaceId: Map<WorkspaceId, BridgeRecord> }).recordsByWorkspaceId;
  const record = records.get(workspaceId);
  expect(record).toBeDefined();
  return record;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStrictlyIncreasing(samples: number[]): boolean {
  return samples.every((sample, index) => index === 0 || sample > samples[index - 1]);
}
