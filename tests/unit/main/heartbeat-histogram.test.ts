import { expect, test } from "bun:test";
import { heartbeatHistogramLine } from "../../../src/main/infra/agent/heartbeat-histogram";

const empty = () => new Array<number>(11).fill(0);

test("no beats and all on-time beats write no line", () => {
  expect(heartbeatHistogramLine(1000, empty())).toBeNull();
  const onTime = empty();
  onTime[0] = 60;
  expect(heartbeatHistogramLine(1000, onTime)).toBeNull();
});

test("a late beat writes one line with the counts", () => {
  const h = empty();
  h[0] = 58;
  h[1] = 1;
  h[10] = 1;
  const line = heartbeatHistogramLine(1000, h);
  expect(line).toContain("interval=1000ms, total=60, late=2");
  expect(line).toContain("[0-1x]:58");
  expect(line).toContain("[10+x]:1");
  expect(line?.includes("\n")).toBe(false);
});
