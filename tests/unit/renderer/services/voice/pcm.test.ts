import { describe, expect, test } from "bun:test";
import { frameSamples, pcm16Of } from "../../../../../src/renderer/services/voice/pcm";

describe("microphone samples as the voice socket takes them", () => {
  test("are 16-bit little-endian, full scale at ±1, clipped beyond", () => {
    const bytes = pcm16Of(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    const view = new DataView(bytes.buffer);
    const values = Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true));
    expect(values).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
    expect(bytes.length).toBe(12);
  });

  test("go in frames of 100 ms at the server's rate", () => {
    expect(frameSamples(16000)).toBe(1600);
    expect(frameSamples(24000)).toBe(2400);
  });
});
