import { expect, it } from "vite-plus/test";
import { encodeDictationWav } from "./dictationAudio";

it("preserves ordered microphone chunks and clamps PCM without wrapping", () => {
  const bytes = encodeDictationWav([new Float32Array([-2, 0]), new Float32Array([0.5, 2])]);
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(8);
  expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([
    -32768, 0, 16384, 32767,
  ]);
});

it("refuses empty recordings and audio beyond five minutes", () => {
  expect(() => encodeDictationWav([])).toThrow();
  expect(() => encodeDictationWav([new Float32Array(16000 * 300 + 1)])).toThrow();
});
