import { checkDatabase } from "@grausvera/database";
import { type AppConfig, createLogger, loadConfig } from "@grausvera/operations";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const correlationId = randomUUID();
  let config: AppConfig;

  try {
    config = loadConfig();
  } catch {
    createLogger("web", process.env.NODE_ENV ?? "development").write("error", {
      event: "health_checked",
      correlationId,
      status: "unhealthy",
      errorCode: "configuration_invalid",
    });
    return Response.json({ status: "unhealthy", correlationId }, { status: 503 });
  }

  try {
    await checkDatabase(config.DATABASE_URL);
    createLogger("web", config.NODE_ENV, config.LOG_LEVEL).write("info", {
      event: "health_checked",
      correlationId,
      status: "healthy",
    });
    return Response.json({ status: "healthy", correlationId });
  } catch {
    createLogger("web", config.NODE_ENV, config.LOG_LEVEL).write("error", {
      event: "health_checked",
      correlationId,
      status: "unhealthy",
      errorCode: "database_unavailable",
    });
    return Response.json({ status: "unhealthy", correlationId }, { status: 503 });
  }
}
