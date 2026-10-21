// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns a persistent native speech process and its line protocol.
// @effect-diagnostics globalTimers:off -- Native protocol deadlines span individual IPC calls.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

type PendingTranscript = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

export class PhononWorker {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<string, PendingTranscript>();
  private sequence = 0;
  private closed = false;

  constructor(directory: string) {
    this.child = NodeChildProcess.spawn(NodePath.join(directory, "t3-speech-worker"), [
      NodePath.join(directory, "model"),
    ]);
    this.child.stderr.resume();
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = NodeReadline.createInterface({ input: this.child.stdout });
      let startupTimer: ReturnType<typeof setTimeout>;
      const fail = (error: Error) => {
        clearTimeout(startupTimer);
        this.closed = true;
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        lines.close();
      };
      startupTimer = setTimeout(() => {
        fail(new Error("Local speech took too long to prepare. Try again."));
        this.child.kill();
      }, 180000);
      this.child.on("error", () =>
        fail(new Error("Local speech is not installed. Finish dictation setup before recording.")),
      );
      this.child.on("exit", () => fail(new Error("The local speech process stopped. Try again.")));
      this.child.stdin.on("error", () => fail(new Error("The local speech process disconnected.")));
      lines.on("line", (line) => {
        try {
          const result: unknown = JSON.parse(line);
          if (typeof result !== "object" || result === null || !("type" in result))
            throw new Error();
          if (result.type === "ready") {
            clearTimeout(startupTimer);
            resolve();
            return;
          }
          if (!("id" in result) || typeof result.id !== "string") throw new Error();
          const pending = this.pending.get(result.id);
          if (!pending) return;
          this.pending.delete(result.id);
          if (result.type === "transcript" && "text" in result && typeof result.text === "string")
            pending.resolve(result.text);
          else pending.reject(new Error("Local speech could not transcribe this recording."));
        } catch {
          fail(new Error("Local speech returned an invalid response."));
          this.child.kill();
        }
      });
    });
    void this.ready.catch(() => {});
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async prepare(signal: AbortSignal): Promise<void> {
    await this.withCancellation(this.ready, signal, false);
  }

  async transcribeFile(path: string, signal: AbortSignal): Promise<string> {
    await this.prepare(signal);
    signal.throwIfAborted();
    if (this.closed) throw new Error("Local speech has stopped. Try again.");
    const id = String(++this.sequence);
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, path })}\n`);
    });
    return this.withCancellation(result, signal, true);
  }

  dispose(): void {
    this.closed = true;
    this.child.kill();
  }

  private async withCancellation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    stopWorker: boolean,
  ): Promise<T> {
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        if (stopWorker) this.dispose();
        reject(new DOMException("Transcription cancelled.", "AbortError"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const timer = stopWorker
      ? setTimeout(() => {
          this.dispose();
        }, 180000)
      : undefined;
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
    }
  }
}
