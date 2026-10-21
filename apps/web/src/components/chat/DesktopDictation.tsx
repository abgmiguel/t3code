import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";
import { Button } from "../ui/button";
import {
  DICTATION_LIMIT_SECONDS,
  DICTATION_SAMPLE_RATE,
  encodeDictationWav,
} from "./dictationAudio";

type Capture = {
  context: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  chunks: Float32Array[];
  samples: number;
  timer: ReturnType<typeof setTimeout>;
};

export function DesktopDictation(props: {
  ownerKey: string;
  disabled: boolean;
  readDraft: () => VoiceDraftSnapshot;
  commitDraft: (text: string, cursor: number) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const release = useStableCallback(() => {
    const active = capture.current;
    capture.current = null;
    if (!active) return;
    clearTimeout(active.timer);
    active.node.port.close();
    active.node.disconnect();
    active.stream.getTracks().forEach((track) => track.stop());
    void active.context.close().catch(() => {});
  });

  const cancel = () => {
    generation.current++;
    release();
    void window.desktopBridge?.cancelDictation?.();
    setPhase("idle");
    latest.current.onBusyChange(false);
  };

  useEffect(() => {
    if (window.desktopBridge?.getClientPlatform?.() === "darwin") {
      void window.desktopBridge.prepareDictation?.().catch(() => {});
    }
    return () => {
      generation.current++;
      release();
      void window.desktopBridge?.cancelDictation?.();
      latest.current.onBusyChange(false);
    };
  }, [release]);

  useEffect(() => {
    if (phase !== "recording") return;
    const began = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const start = async () => {
    if (phase !== "idle") return;
    const token = ++generation.current;
    const draft = latest.current.readDraft();
    setError(null);
    setSeconds(0);
    setPhase("preparing");
    latest.current.onBusyChange(true);
    let pendingStream: MediaStream | null = null;
    let pendingContext: AudioContext | null = null;
    try {
      pendingStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      if (token !== generation.current) return;
      pendingContext = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
      if (pendingContext.sampleRate !== DICTATION_SAMPLE_RATE)
        throw new Error("This microphone cannot record at 16 kHz.");
      // The desktop CSP requires a same-origin worklet asset, never a blob or data URL.
      await pendingContext.audioWorklet.addModule(
        new URL("./dictationCapture.worklet.js?no-inline", import.meta.url).href,
      );
      if (token !== generation.current) return;
      await pendingContext.resume();
      if (token !== generation.current) return;
      const node = new AudioWorkletNode(pendingContext, "dictation-capture");
      const source = pendingContext.createMediaStreamSource(pendingStream);
      const muted = pendingContext.createGain();
      muted.gain.value = 0;
      source.connect(node).connect(muted).connect(pendingContext.destination);
      const active: Capture = {
        context: pendingContext,
        stream: pendingStream,
        node,
        chunks: [],
        samples: 0,
        timer: setTimeout(() => {
          void stop(draft, token);
        }, DICTATION_LIMIT_SECONDS * 1000),
      };
      capture.current = active;
      pendingStream = null;
      pendingContext = null;
      node.port.addEventListener("message", (event: MessageEvent<Float32Array>) => {
        if (token !== generation.current || capture.current !== active) return;
        const remaining = DICTATION_SAMPLE_RATE * DICTATION_LIMIT_SECONDS - active.samples;
        if (remaining <= 0) {
          void stop(draft, token);
          return;
        }
        const chunk = event.data.subarray(0, remaining);
        active.chunks.push(chunk);
        active.samples += chunk.length;
      });
      node.port.start();
      node.addEventListener("processorerror", () => {
        cancel();
        setError("The microphone recording was interrupted. Try again.");
      });
      for (const track of active.stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (capture.current === active) {
            cancel();
            setError("The microphone disconnected. Try recording again.");
          }
        });
      }
      snapshot.current = { draft, token };
      setPhase("recording");
    } catch (cause) {
      if (token !== generation.current) return;
      release();
      setError(cause instanceof Error ? cause.message : "Could not start the microphone.");
      setPhase("idle");
      latest.current.onBusyChange(false);
    } finally {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (pendingContext) void pendingContext.close().catch(() => {});
    }
  };

  const snapshot = useRef<{ draft: VoiceDraftSnapshot; token: number } | null>(null);
  const stop = async (draft: VoiceDraftSnapshot, token: number) => {
    const active = capture.current;
    if (!active || token !== generation.current) return;
    const chunks = active.chunks;
    release();
    setPhase("transcribing");
    try {
      const transcribe = window.desktopBridge?.transcribeDictation;
      if (!transcribe) throw new Error("Local dictation is unavailable in this app version.");
      const result = await transcribe(encodeDictationWav(chunks));
      if (token !== generation.current) return;
      if ("error" in result) throw new Error(result.error);
      const commit = resolveTranscriptCommit(draft, latest.current.readDraft(), result.text, "en");
      if (commit.kind !== "commit")
        throw new Error("The draft changed. Record again in the current draft.");
      latest.current.commitDraft(commit.text, commit.selection.start);
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : "Transcription failed. Try again.");
    } finally {
      if (token === generation.current) {
        setPhase("idle");
        latest.current.onBusyChange(false);
      }
    }
  };

  if (
    window.desktopBridge?.getClientPlatform?.() !== "darwin" ||
    !window.desktopBridge.transcribeDictation
  )
    return null;
  const busy = phase !== "idle";
  return (
    <div className="flex items-center gap-1" aria-busy={busy}>
      <span role={error ? "alert" : "status"} className="max-w-64 text-xs text-muted-foreground">
        {error ??
          (phase === "recording"
            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
            : phase === "transcribing"
              ? "Transcribing locally…"
              : phase === "preparing"
                ? "Opening microphone…"
                : null)}
      </span>
      <Button
        variant={phase === "recording" ? "ghost-destructive" : "ghost-muted"}
        size="icon"
        disabled={
          (phase === "idle" && props.disabled) || phase === "preparing" || phase === "transcribing"
        }
        aria-label={phase === "recording" ? "Stop recording and transcribe" : "Record voice prompt"}
        title="Local voice dictation"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (phase === "recording" && snapshot.current)
            void stop(snapshot.current.draft, snapshot.current.token);
          else if (!busy) void start();
        }}
      >
        {phase === "recording" ? <SquareIcon className="size-4" /> : <MicIcon className="size-4" />}
      </Button>
      {busy ? (
        <Button variant="ghost-muted" size="icon" aria-label="Cancel dictation" onClick={cancel}>
          <XIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
