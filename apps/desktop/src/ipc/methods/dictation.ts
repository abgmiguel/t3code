import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import {
  LocalDictationError,
  prepareLocalDictation,
  transcribeLocally,
} from "../../dictation/localTranscription.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const operations = new Map<number, AbortController>();

class DictationFailure extends Schema.TaggedError<DictationFailure>()("DictationFailure", {
  cause: Schema.Defect(),
}) {}

export const prepareDictation = makeIpcMethod({
  channel: IpcChannels.DICTATION_PREPARE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({ error: Schema.optional(Schema.String) }),
  handler: Effect.fn("desktop.ipc.dictation.prepare")(function* () {
    const environment = yield* DesktopEnvironment;
    const path = yield* Path.Path;
    if (environment.platform !== "darwin")
      return { error: "Local dictation requires the Mac desktop app." };
    return yield* Effect.tryPromise(async (signal) => {
      await prepareLocalDictation(
        path.join(environment.homeDirectory, "Library", "Application Support", "T3Dictation"),
        signal,
      );
      return {};
    }).pipe(Effect.orElseSucceed(() => ({ error: "Local speech could not get ready." })));
  }),
});

export const transcribeDictation = makeIpcMethod({
  channel: IpcChannels.DICTATION_TRANSCRIBE_CHANNEL,
  payload: Schema.Uint8Array,
  result: Schema.Union([
    Schema.Struct({ text: Schema.String }),
    Schema.Struct({ error: Schema.String }),
  ]),
  handler: Effect.fn("desktop.ipc.dictation.transcribe")(function* (audio, event) {
    const environment = yield* DesktopEnvironment;
    const path = yield* Path.Path;
    const owner = event?.sender.id;
    if (environment.platform !== "darwin" || owner === undefined) {
      return { error: "Local dictation requires the Mac desktop app." };
    }
    if (operations.size > 0) return { error: "Another local transcription is already finishing." };
    const controller = new AbortController();
    operations.set(owner, controller);
    return yield* Effect.tryPromise({
      try: async () => ({
        text: await transcribeLocally(
          path.join(environment.homeDirectory, "Library", "Application Support", "T3Dictation"),
          audio,
          controller.signal,
        ),
      }),
      catch: (cause) => new DictationFailure({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          error: controller.signal.aborted
            ? "Transcription cancelled."
            : cause.cause instanceof LocalDictationError
              ? cause.cause.message
              : "Local transcription failed. Check the Phonon installation, then try again.",
        }),
      ),
      Effect.ensuring(Effect.sync(() => operations.delete(owner))),
    );
  }),
});

export const cancelDictation = makeIpcMethod({
  channel: IpcChannels.DICTATION_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.cancel")((_, event) =>
    Effect.sync(() => {
      if (event) operations.get(event.sender.id)?.abort();
    }),
  ),
});
