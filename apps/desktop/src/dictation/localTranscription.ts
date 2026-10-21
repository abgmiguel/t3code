// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns the native speech subprocess and its temporary audio.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PhononWorker } from "./PhononWorker.ts";

let worker: { directory: string; process: PhononWorker } | null = null;

function speechWorker(directory: string): PhononWorker {
  if (!worker || worker.directory !== directory || worker.process.isClosed) {
    worker?.process.dispose();
    worker = { directory, process: new PhononWorker(directory) };
  }
  return worker.process;
}

export function disposeLocalDictation(): void {
  worker?.process.dispose();
  worker = null;
}

export async function prepareLocalDictation(directory: string, signal: AbortSignal): Promise<void> {
  await speechWorker(directory).prepare(signal);
}
export const MAX_DICTATION_BYTES = 16000 * 2 * 300 + 44;
export class LocalDictationError extends Error {}

export function validateDictationAudio(audio: Uint8Array): void {
  if (audio.byteLength <= 44 || audio.byteLength > MAX_DICTATION_BYTES) {
    throw new LocalDictationError("Record between a moment and five minutes of speech.");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (offset: number) => String.fromCharCode(...audio.subarray(offset, offset + 4));
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    tag(12) !== "fmt " ||
    tag(36) !== "data" ||
    view.getUint32(4, true) !== audio.byteLength - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16000 ||
    view.getUint32(28, true) !== 32000 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== audio.byteLength - 44 ||
    audio.byteLength % 2 !== 0
  )
    throw new LocalDictationError("The microphone recording has an unsupported format.");
}

export function parseDictationResult(value: unknown): string {
  const rows = typeof value === "object" && value !== null && "rows" in value ? value.rows : null;
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.text !== "string") {
    throw new LocalDictationError("Local speech returned an invalid transcript.");
  }
  const text = rows[0].text.trim();
  if (!text)
    throw new LocalDictationError("No speech detected. Try again closer to the microphone.");
  if (text.length > 20000)
    throw new LocalDictationError("This transcript is too long. Try a shorter recording.");
  return text;
}

export async function transcribeLocally(
  runtimeDirectory: string,
  audio: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  validateDictationAudio(audio);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-"));
  try {
    const input = NodePath.join(directory, "recording.wav");
    await NodeFSP.writeFile(input, audio, { mode: 0o600, signal });
    const text = await speechWorker(runtimeDirectory).transcribeFile(input, signal);
    return parseDictationResult({ rows: [{ text }] });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
