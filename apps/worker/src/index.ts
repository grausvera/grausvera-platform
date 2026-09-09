import { createLogger, loadConfig } from "@grausvera/operations";
import { startWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger("worker", config.NODE_ENV, config.LOG_LEVEL);
  const runtime = await startWorker(config, logger);
  let stopping = false;

  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.write("info", { event: "shutdown_requested", status: signal });
    await runtime.stop();
  }

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch(() => {
  createLogger("worker", process.env.NODE_ENV ?? "development").write("error", {
    event: "worker_start_failed",
    errorCode: "startup_failed",
    status: "stopped",
  });
  process.exitCode = 1;
});
