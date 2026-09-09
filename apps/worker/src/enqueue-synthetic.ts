import { createLogger, loadConfig } from "@grausvera/operations";
import { PgBoss } from "pg-boss";
import { randomUUID } from "node:crypto";
import { syntheticQueue } from "./worker.js";

const config = loadConfig();
const logger = createLogger("worker", config.NODE_ENV, config.LOG_LEVEL);
const boss = new PgBoss({ connectionString: config.DATABASE_URL });

try {
  await boss.start();
  await boss.createQueue(syntheticQueue);
  const correlationId = randomUUID();
  const jobId = await boss.send(syntheticQueue, { correlationId });
  if (!jobId) throw new Error("Synthetic job was not created");
  logger.write("info", {
    event: "synthetic_job_queued",
    correlationId,
    jobId,
    queue: syntheticQueue,
    status: "created",
  });
} finally {
  await boss.stop({ close: true, graceful: true, timeout: 10_000 });
}
