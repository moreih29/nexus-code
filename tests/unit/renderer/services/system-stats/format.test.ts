import { expect, test } from "bun:test";
import {
  drawableStats,
  memoryLabel,
  memoryPercent,
} from "../../../../../src/renderer/services/system-stats/format";

const GIB = 1024 ** 3;

test("numbers past what can be drawn are cut to it, not shown as told", () => {
  const told = { cpu: 140, memUsed: 64 * GIB, memTotal: 32 * GIB };
  const drawn = drawableStats(told);
  expect(drawn).toEqual({ cpu: 100, memUsed: 32 * GIB, memTotal: 32 * GIB });
  expect(drawn && memoryPercent(drawn.memUsed, drawn.memTotal)).toBe(100);
  expect(drawn && memoryLabel(drawn.memUsed, drawn.memTotal)).toBe("32.0/32 GB");
  expect(drawableStats({ cpu: -3, memUsed: -1, memTotal: GIB })).toEqual({
    cpu: 0,
    memUsed: 0,
    memTotal: GIB,
  });
  expect(drawableStats({ cpu: null, memUsed: Infinity, memTotal: GIB })).toEqual({
    cpu: null,
    memUsed: GIB,
    memTotal: GIB,
  });
  expect(drawableStats({ cpu: 1, memUsed: 1, memTotal: Infinity })).toBeNull();
  const fine = { cpu: 23.4, memUsed: 12 * GIB, memTotal: 32 * GIB };
  expect(drawableStats(fine)).toEqual(fine);
});
