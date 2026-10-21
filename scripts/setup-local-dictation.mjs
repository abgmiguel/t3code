import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This bootstrap runs before workspace dependencies are installed.
if (NodeOS.platform() !== "darwin" || NodeOS.arch() !== "arm64") {
  throw new Error("Local Phonon dictation requires an Apple Silicon Mac with macOS 15 or later.");
}
const runtimeCommit = "bf59e574639b060e30ee1a3f9c0e003fed5744c8";
const modelRevision = "1143812fd4236522232a8c33e3115f0577e3cd7d";
const directory = NodePath.join(NodeOS.homedir(), "Library", "Application Support", "T3Dictation");
const runtime = NodePath.join(directory, "phonon-coreml");
const model = NodePath.join(directory, "model");
const babyScribe = process.argv[2] ? NodePath.resolve(process.argv[2]) : null;
const exists = async (path) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );
await NodeFSP.mkdir(directory, { recursive: true });
if (!(await exists(runtime))) {
  NodeChildProcess.execFileSync(
    "git",
    [
      "clone",
      "--branch",
      "1.1.2",
      "--depth",
      "1",
      "https://github.com/fermionresearch/phonon-coreml.git",
      runtime,
    ],
    { stdio: "inherit" },
  );
}
const actual = NodeChildProcess.execFileSync("git", ["-C", runtime, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (
  actual !== runtimeCommit ||
  NodeChildProcess.execFileSync("git", ["-C", runtime, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim()
) {
  throw new Error("Inspect the modified Phonon runtime before rebuilding it.");
}
await NodeFSP.mkdir(model, { recursive: true });
const files = [
  "SHA256SUMS",
  "manifest.json",
  "decoder.bin",
  "NOTICE",
  "LICENSE-CODE-Apache-2.0.txt",
  "LICENSE-WEIGHTS-CC-BY-4.0.txt",
  "Phonon-2.mlpackage/Manifest.json",
  "Phonon-2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
  "Phonon-2.mlpackage/Data/com.apple.CoreML/weights/weight.bin",
];
for (const file of files) {
  const destination = NodePath.join(model, file);
  if (await exists(destination)) continue;
  await NodeFSP.mkdir(NodePath.resolve(destination, ".."), { recursive: true });
  const partial = `${destination}.part`;
  if (await exists(partial))
    throw new Error(`Inspect the interrupted model download at ${partial}`);
  if (babyScribe) {
    await NodeFSP.copyFile(
      NodePath.join(babyScribe, "modules/baby-scribe-transcription/ios/Vendor/PhononModel", file),
      partial,
      NodeFS.constants.COPYFILE_FICLONE,
    );
  } else {
    NodeChildProcess.execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--output",
        partial,
        `https://huggingface.co/FermionResearch/Phonon-2-CoreML/resolve/${modelRevision}/${file}`,
      ],
      { stdio: "inherit" },
    );
  }
  await NodeFSP.rename(partial, destination);
}
const checksums = new Map(
  (await NodeFSP.readFile(NodePath.join(model, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, file] = line.trim().split(/\s+/, 2);
      return [file.replace(/^\*?(\.\/)?/, ""), hash];
    }),
);
for (const file of files.filter((file) => file !== "SHA256SUMS")) {
  const hash = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(NodePath.join(model, file)))
    .digest("hex");
  if (hash !== checksums.get(file)) throw new Error(`Phonon model checksum mismatch: ${file}`);
}
const workerSource = NodePath.join(directory, "worker");
const workerTemplate = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../native/dictation",
);
await NodeFSP.mkdir(workerSource, { recursive: true });
await NodeFSP.cp(
  NodePath.join(workerTemplate, "Package.swift"),
  NodePath.join(workerSource, "Package.swift"),
);
await NodeFSP.cp(NodePath.join(workerTemplate, "Sources"), NodePath.join(workerSource, "Sources"), {
  recursive: true,
});
NodeChildProcess.execFileSync(
  "swift",
  [
    "build",
    "--package-path",
    workerSource,
    "-c",
    "release",
    "--product",
    "T3SpeechWorker",
    "--jobs",
    "2",
  ],
  { stdio: "inherit" },
);
const bin = NodeChildProcess.execFileSync(
  "swift",
  ["build", "--package-path", workerSource, "-c", "release", "--show-bin-path"],
  { encoding: "utf8" },
).trim();
const candidate = NodePath.join(directory, "t3-speech-worker.next");
await NodeFSP.cp(NodePath.join(bin, "T3SpeechWorker"), candidate);
await NodeFSP.chmod(candidate, 0o755);
await NodeFSP.rename(candidate, NodePath.join(directory, "t3-speech-worker"));
console.log(`Local Phonon-2 dictation installed at ${directory}`);
