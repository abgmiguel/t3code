// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise real subprocess and temporary-file cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_DICTATION_BYTES,
  parseDictationResult,
  transcribeLocally,
  validateDictationAudio,
  disposeLocalDictation,
  prepareLocalDictation,
} from "./localTranscription.ts";

function recording() {
  return new Uint8Array(
    Buffer.from(
      "524946462800000057415645666d74201000000001000100803e0000007d00000200100064617461040000000000ff7f",
      "hex",
    ),
  );
}

describe("local dictation boundary", () => {
  it("accepts mono 16 kHz PCM and rejects malformed or oversized recordings", () => {
    expect(() => validateDictationAudio(recording())).not.toThrow();
    for (const input of [
      new Uint8Array(),
      new Uint8Array(MAX_DICTATION_BYTES + 1),
      recording().subarray(0, 46),
    ]) {
      expect(() => validateDictationAudio(input)).toThrow();
    }
    const stereo = recording();
    stereo[22] = 2;
    expect(() => validateDictationAudio(stereo)).toThrow("unsupported format");
  });

  it("reads the native CLI result and rejects silence and malformed output", () => {
    expect(parseDictationResult({ rows: [{ text: "  Change the title.  " }] })).toBe(
      "Change the title.",
    );
    expect(() => parseDictationResult({ rows: [{ text: " " }] })).toThrow("No speech detected");
    for (const result of [
      null,
      [],
      { rows: [] },
      { rows: [{ text: 1 }] },
      { rows: [{ text: "x" }, { text: "y" }] },
    ]) {
      expect(() => parseDictationResult(result)).toThrow("invalid transcript");
    }
  });

  it("separates attached numbers after ordinary words without splitting identifiers", () => {
    for (const [raw, expected] of [
      ["The baby ate at245.", "The baby ate at 245."],
      ["Baby drank90 ml around230.", "Baby drank 90 ml around 230."],
      [
        "GPT5 B12 ESP32 https://at245.com at245@example.com",
        "GPT5 B12 ESP32 https://at245.com at245@example.com",
      ],
    ]) {
      expect(parseDictationResult({ rows: [{ text: raw }] })).toBe(expected);
    }
  });

  it("reuses one native process for consecutive recordings and removes temporary audio", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dictation test "));
    try {
      const marker = NodePath.join(directory, "requests");
      await installWorker(directory, marker, true);
      const signal = new AbortController().signal;
      await prepareLocalDictation(directory, signal);
      expect(await transcribeLocally(directory, recording(), signal)).toBe(
        "Run the focused tests.",
      );
      expect(await transcribeLocally(directory, recording(), signal)).toBe(
        "Run the focused tests.",
      );
      const requests = (await NodeFSP.readFile(marker, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toHaveLength(2);
      expect(requests[0].pid).toBe(requests[1].pid);
      for (const request of requests) {
        await expect(NodeFSP.readdir(request.directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      disposeLocalDictation();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans up when cancellation arrives before native inference", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribeLocally("/missing", recording(), controller.signal)).rejects.toThrow();
  });

  it("cancels a preparation waiter without stranding the next recording", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dictation-prepare-"));
    const controller = new AbortController();
    try {
      const marker = NodePath.join(directory, "requests");
      await installWorker(directory, marker, true, true);
      const events = NodeFSP.watch(directory);
      const assertion = expect(
        prepareLocalDictation(directory, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      for await (const event of events) {
        if (event.filename === "requests-starting") break;
      }
      controller.abort();
      await assertion;
      await NodeFSP.writeFile(NodePath.join(directory, "release"), "");
      expect(await transcribeLocally(directory, recording(), new AbortController().signal)).toBe(
        "Run the focused tests.",
      );
    } finally {
      controller.abort();
      disposeLocalDictation();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels a running native process and removes its recording", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dictation-cancel-"));
    const controller = new AbortController();
    try {
      const marker = NodePath.join(directory, "requests");
      await installWorker(directory, marker, false);
      const events = NodeFSP.watch(directory);
      const pending = transcribeLocally(directory, recording(), controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      for await (const event of events) {
        if (event.filename === "requests") break;
      }
      const request = JSON.parse((await NodeFSP.readFile(marker, "utf8")).trim());
      controller.abort();
      await assertion;
      await expect(NodeFSP.readdir(request.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      disposeLocalDictation();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

async function installWorker(
  directory: string,
  marker: string,
  respond: boolean,
  deferReady = false,
) {
  await NodeFSP.writeFile(
    NodePath.join(directory, "t3-speech-worker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (${deferReady}) {
  const watch = fs.watch(${JSON.stringify(directory)}, (_event, name) => {
    if (name === 'release') { watch.close(); console.log(JSON.stringify({type: 'ready'})); }
  });
  fs.writeFileSync(${JSON.stringify(marker + "-starting")}, '');
} else console.log(JSON.stringify({type: 'ready'}));
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, directory: require('node:path').dirname(request.path)}) + '\\n');
  if (${respond}) console.log(JSON.stringify({type: 'transcript', id: request.id, text: 'Run the focused tests.'}));
});
`,
    { mode: 0o755 },
  );
}
