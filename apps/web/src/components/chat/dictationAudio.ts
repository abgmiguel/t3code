export const DICTATION_SAMPLE_RATE = 16000;
export const DICTATION_LIMIT_SECONDS = 300;

export function encodeDictationWav(chunks: readonly Float32Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (length === 0 || length > DICTATION_SAMPLE_RATE * DICTATION_LIMIT_SECONDS) {
    throw new Error("Record between a moment and five minutes of speech.");
  }
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return bytes;
}
