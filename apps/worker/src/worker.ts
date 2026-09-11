import {
  BriefDeliveryService,
  BudgetStore,
  EmailDeliveryStore,
  EmailVerificationOutboxStore,
  LocalObjectPort,
  MessagingStore,
  OperationalInspectionStore,
} from "@grausvera/database";
import { type AppConfig, createLogger, type Logger } from "@grausvera/operations";
import { PgBoss } from "pg-boss";
import {
  AesGcmEmailSecretCodec,
  BriefDeliveryDispatcher,
  EmailOutboxDispatcher,
  ResendEmailPort,
} from "./email.js";
import { MetaMessagingPort, OutboxDispatcher } from "./messaging.js";
import { MetaInboxReconciler } from "./meta-inbound.js";
import { reconcileOperationalState, RECONCILIATION_INTERVAL_MS } from "./reconciliation.js";

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
  const emailStore = new EmailVerificationOutboxStore(config.DATABASE_URL);
  const emailDeliveryStore = new EmailDeliveryStore(config.DATABASE_URL);
  const budgetStore = new BudgetStore(config.DATABASE_URL);
  const inspectionStore = new OperationalInspectionStore(config.DATABASE_URL);
  const objects = new LocalObjectPort(config.OBJECT_STORAGE_ROOT);
  const briefDeliveryService = new BriefDeliveryService(config.DATABASE_URL, objects);
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
  const emailDispatcher = new EmailOutboxDispatcher(
    emailStore,
    new ResendEmailPort({
      apiKey: config.RESEND_API_KEY ?? "disabled",
      baseUrl: config.RESEND_BASE_URL,
      from: config.RESEND_FROM ?? "disabled",
      timeoutMs: 10_000,
    }),
    new AesGcmEmailSecretCodec(
      config.EMAIL_SECRET_KEY_BASE64
        ? Buffer.from(config.EMAIL_SECRET_KEY_BASE64, "base64")
        : Buffer.alloc(32),
      config.EMAIL_SECRET_KEY_REFERENCE,
    ),
  );
  emailDispatcher.setEnabled(config.EMAIL_EMITTER_ENABLED);
  const briefDeliveryDispatcher = new BriefDeliveryDispatcher(
    briefDeliveryService,
    emailDeliveryStore,
    objects,
    new ResendEmailPort({
      apiKey: config.RESEND_API_KEY ?? "disabled",
      baseUrl: config.RESEND_BASE_URL,
      from: config.RESEND_FROM ?? "disabled",
      timeoutMs: 10_000,
    }),
    new AesGcmEmailSecretCodec(
      config.EMAIL_SECRET_KEY_BASE64
        ? Buffer.from(config.EMAIL_SECRET_KEY_BASE64, "base64")
        : Buffer.alloc(32),
      config.EMAIL_SECRET_KEY_REFERENCE,
    ),
  );
  briefDeliveryDispatcher.setEnabled(config.EMAIL_EMITTER_ENABLED);
  const reconciliationCapabilities = {
    messaging: messagingStore,
    verificationEmail: emailStore,
    deliveryEmail: emailDeliveryStore,
    budget: budgetStore,
    inspection: inspectionStore,
  };
  const startupReconciliation = await reconcileOperationalState(reconciliationCapabilities);
  operationalLogger.write(startupReconciliation.inspection.actions.length > 0 ? "warn" : "info", {
    event: "operational_reconciliation_completed",
    status:
      startupReconciliation.inspection.actions.length > 0
        ? `actions:${startupReconciliation.inspection.actions.length}`
        : "healthy",
  });
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
  let activeEmailDispatch: Promise<unknown> | undefined;
  let activeBriefDelivery: Promise<unknown> | undefined;
  let activeReconciliation: Promise<unknown> | undefined;
  let activeOperationalReconciliation: Promise<unknown> | undefined;
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
  const emailDispatchTimer = setInterval(() => {
    if (activeEmailDispatch) return;
    activeEmailDispatch = emailDispatcher
      .dispatchOne()
      .catch(() => {
        operationalLogger.write("error", {
          event: "email_outbox_dispatch_failed",
          errorCode: "email_dispatcher_failed",
        });
      })
      .finally(() => {
        activeEmailDispatch = undefined;
      });
  }, 1_000);
  const briefDeliveryTimer = setInterval(() => {
    if (activeBriefDelivery) return;
    activeBriefDelivery = briefDeliveryDispatcher
      .dispatchOne()
      .catch(() => {
        operationalLogger.write("error", {
          event: "brief_delivery_dispatch_failed",
          errorCode: "email_dispatcher_failed",
        });
      })
      .finally(() => {
        activeBriefDelivery = undefined;
      });
  }, 1_000);
  const operationalReconciliationTimer = setInterval(() => {
    if (activeOperationalReconciliation) return;
    const startedAt = Date.now();
    activeOperationalReconciliation = reconcileOperationalState(reconciliationCapabilities)
      .then((result) => {
        operationalLogger.write(result.inspection.actions.length > 0 ? "warn" : "info", {
          event: "operational_reconciliation_completed",
          durationMs: Date.now() - startedAt,
          status:
            result.inspection.actions.length > 0
              ? `actions:${result.inspection.actions.length}`
              : "healthy",
        });
      })
      .catch(() => {
        operationalLogger.write("error", {
          event: "operational_reconciliation_failed",
          errorCode: "reconciler_failed",
        });
      })
      .finally(() => {
        activeOperationalReconciliation = undefined;
      });
  }, RECONCILIATION_INTERVAL_MS);
  operationalLogger.write("info", {
    event: "worker_started",
    queue: syntheticQueue,
    status: "ready",
  });

  return {
    async stop() {
      dispatcher.setEnabled(false);
      emailDispatcher.setEnabled(false);
      briefDeliveryDispatcher.setEnabled(false);
      clearInterval(dispatchTimer);
      clearInterval(emailDispatchTimer);
      clearInterval(briefDeliveryTimer);
      clearInterval(reconciliationTimer);
      clearInterval(operationalReconciliationTimer);
      await Promise.all([
        activeDispatch,
        activeEmailDispatch,
        activeBriefDelivery,
        activeReconciliation,
        activeOperationalReconciliation,
      ]);
      await boss.offWork(syntheticQueue, { wait: true });
      await boss.stop({ close: true, graceful: true, timeout: 10_000 });
      await messagingStore.close();
      await emailStore.close();
      await emailDeliveryStore.close();
      await budgetStore.close();
      await inspectionStore.close();
      await briefDeliveryService.close();
      operationalLogger.write("info", {
        event: "worker_stopped",
        queue: syntheticQueue,
        status: "stopped",
      });
    },
  };
}
