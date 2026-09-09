import { createLogger, type Logger, type AppConfig } from "@grausvera/operations";
import { PgBoss } from "pg-boss";

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
  operationalLogger.write("info", {
    event: "worker_started",
    queue: syntheticQueue,
    status: "ready",
  });

  return {
    async stop() {
      await boss.offWork(syntheticQueue, { wait: true });
      await boss.stop({ close: true, graceful: true, timeout: 10_000 });
      operationalLogger.write("info", {
        event: "worker_stopped",
        queue: syntheticQueue,
        status: "stopped",
      });
    },
  };
}
