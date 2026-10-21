import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Option from "effect/Option";
import * as RuntimePolicy from "./RuntimePolicy.ts";

export class ProviderThreadArchiveError extends Schema.TaggedError<ProviderThreadArchiveError>()(
  "ProviderThreadArchiveError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}

export class ProviderThreadArchiveService extends Context.Service<
  ProviderThreadArchiveService,
  { readonly sync: (threadId: ThreadId) => Effect.Effect<void, ProviderThreadArchiveError> }
>()("t3/orchestration-v2/ProviderThreadArchiveService") {}

export const layer = Layer.effect(
  ProviderThreadArchiveService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const policies = yield* RuntimePolicy.RuntimePolicyV2;
    return ProviderThreadArchiveService.of({
      sync: Effect.fn("ProviderThreadArchiveService.sync")(
        function* (threadId) {
          const projection = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
          if (projection.thread.deletedAt !== null) return;
          const archived =
            projection.thread.archivedAt !== null ||
            projection.thread.settledOverride === "settled";
          for (const providerThread of projection.providerThreads) {
            if (
              providerThread.ownerNodeId !== null ||
              providerThread.nativeThreadRef?.nativeId == null
            )
              continue;
            if (providerThread.providerSessionId !== null) {
              const live = yield* sessions.get(providerThread.providerSessionId);
              if (Option.isSome(live) && live.value.setThreadArchived !== undefined) {
                yield* live.value.setThreadArchived({ providerThread, archived });
                continue;
              }
            }
            const adapter = yield* adapters.get(providerThread.providerInstanceId);
            if (adapter.setThreadArchived === undefined) continue;
            const modelSelection = {
              ...projection.thread.modelSelection,
              instanceId: providerThread.providerInstanceId,
            };
            const runtimePolicy = yield* policies.resolve({
              thread: projection.thread,
              modelSelection,
            });
            yield* Effect.scoped(
              adapter.setThreadArchived({
                threadId,
                providerSessionId:
                  providerThread.providerSessionId ??
                  ProviderSessionId.make(`provider-session:archive:${providerThread.id}`),
                modelSelection,
                runtimePolicy,
                providerThread,
                archived,
              }),
            );
          }
        },
        (effect, threadId) =>
          commands
            .withLock(threadId, effect)
            .pipe(Effect.mapError((cause) => new ProviderThreadArchiveError({ threadId, cause }))),
      ),
    });
  }),
);
