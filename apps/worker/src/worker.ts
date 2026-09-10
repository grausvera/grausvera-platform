import { MessagingStore } from "@grausvera/database";
import { createLogger, type Logger, type AppConfig } from "@grausvera/operations";
import { PgBoss } from "pg-boss";
import { MetaMessagingPort, OutboxDispatcher } from "./messaging.js";
import { MetaInboxReconciler } from "./meta-inbound.js";

export const syntheticQueue = "foundation.synthetic";

interface SyntheticJob {
  correlationId: string;
}

export interface WorkerRuntime {
  stop(): Promise<void>;
}

export async function startWorker(config: AppConfig, logger?: Logger): Promise<WorkerRuntime> {
  const operationalLogger = logger ?? createLogger("worker", config.NODE_ENV, config.LOG_LEVEL);
  const boss = new PgBoss({ connectionString: config.DATABASE_URL });
  const messagingStore = new MessagingStore(config.DATABASE_URL);
  const dispatcher = new OutboxDispatcher(
    messagingStore,
    new MetaMessagingPort({
      accessToken: config.META_ACCESS_TOKEN ?? "disabled",
      baseUrl: config.META_GRAPH_BASE_URL,
      phoneNumberId: config.META_PHONE_NUMBER_ID ?? "disabled",
      timeoutMs: 10_000,
    }),
  );
  dispatcher.setEnabled(config.MESSAGING_EMITTER_ENABLED);
  await messagingStore.markAbandonedDispatchesUncertain(new Date());
  await messagingStore.releaseAbandonedInbox();
  const reconciler = new MetaInboxReconciler(messagingStore);

  boss.on("error", () => {
    operationalLogger.write("error", {
      event: "queue_error",
      queue: syntheticQueue,
      errorCode: "queue_unavailable",
    });
  });

  await boss.start();
  await boss.createQueue(syntheticQueue, {
    deleteAfterSeconds: 86_400,
    expireInSeconds: 30,
    retryBackoff: true,
    retryDelay: 1,
    retryLimit: 2,
  });
  await boss.work<SyntheticJob>(syntheticQueue, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) {
      operationalLogger.write("info", {
        event: "synthetic_job_completed",
        correlationId: job.data.correlationId,
        jobId: job.id,
        queue: syntheticQueue,
        status: "completed",
      });
    }
  });
  let activeDispatch: Promise<unknown> | undefined;
  let activeReconciliation: Promise<unknown> | undefined;
  const dispatchTimer = setInterval(() => {
    if (activeDispatch) return;
    activeDispatch = dispatcher
      .dispatchOne()
      .catch(() => {
        operationalLogger.write("error", {
          event: "outbox_dispatch_failed",
          errorCode: "dispatcher_failed",
        });
      })
      .finally(() => {
        activeDispatch = undefined;
      });
  }, 1_000);
  const reconciliationTimer = setInterval(() => {
    if (activeReconciliation) return;
    activeReconciliation = reconciler
      .reconcileOne()
      .catch(() => {
        operationalLogger.write("error", {
          event: "inbox_reconciliation_failed",
          errorCode: "reconciler_failed",
        });
      })
      .finally(() => {
        activeReconciliation = undefined;
      });
  }, 1_000);
  operationalLogger.write("info", {
    event: "worker_started",
    queue: syntheticQueue,
    status: "ready",
  });

  return {
    async stop() {
      dispatcher.setEnabled(false);
      clearInterval(dispatchTimer);
      clearInterval(reconciliationTimer);
      await Promise.all([activeDispatch, activeReconciliation]);
      await boss.offWork(syntheticQueue, { wait: true });
      await boss.stop({ close: true, graceful: true, timeout: 10_000 });
      await messagingStore.close();
      operationalLogger.write("info", {
        event: "worker_stopped",
        queue: syntheticQueue,
        status: "stopped",
      });
    },
  };
}
