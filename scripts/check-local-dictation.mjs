import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parseDictationResult } from "../apps/desktop/src/dictation/localTranscription.ts";
import { PhononWorker } from "../apps/desktop/src/dictation/PhononWorker.ts";

const runtime = NodePath.join(NodeOS.homedir(), "Library", "Application Support", "T3Dictation");
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-check-"));
let worker;
const signal = new AbortController().signal;
try {
  const input = NodePath.join(directory, "sample.aiff");
  NodeChildProcess.execFileSync("say", ["-o", input, "Local dictation is ready."], {
    timeout: 30000,
  });
  const began = performance.now();
  worker = new PhononWorker(runtime);
  await worker.prepare(signal);
  const preparationSeconds = (performance.now() - began) / 1000;
  const recordings = [];
  for (let index = 0; index < 2; index++) {
    const started = performance.now();
    const text = parseDictationResult({
      rows: [{ text: await worker.transcribeFile(input, signal) }],
    });
    if (!text.toLowerCase().includes("dictation"))
      throw new Error(`The speech check did not preserve the test phrase: ${text}`);
    recordings.push({ text, transcriptionSeconds: (performance.now() - started) / 1000 });
  }
  const evidence = {
    checkedAt: new Date().toISOString(),
    preparationSeconds,
    recordings,
    model: "phonon-2-coreml",
    runtimeCommit: "bf59e574639b060e30ee1a3f9c0e003fed5744c8",
  };
  await NodeFSP.writeFile(
    NodePath.join(runtime, "last-speech-check.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  worker?.dispose();
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
