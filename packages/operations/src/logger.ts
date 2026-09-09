export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogWriter = (line: string) => void;

export interface Logger {
  write(level: LogLevel, fields: Record<string, unknown>): void;
}

const allowedOptionalFields = [
  "correlationId",
  "durationMs",
  "errorCode",
  "jobId",
  "queue",
  "status",
] as const;
const opaqueValue = /^[a-zA-Z0-9._:-]{1,128}$/;
const levelPriority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function safeValue(key: (typeof allowedOptionalFields)[number], value: unknown): unknown {
  if (key === "durationMs") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  return typeof value === "string" && opaqueValue.test(value) ? value : undefined;
}

export function createLogger(
  service: string,
  environment: string,
  minimumLevel: LogLevel = "info",
  writeLine: LogWriter = (line) => process.stdout.write(`${line}\n`),
): Logger {
  return {
    write(level, fields) {
      if (levelPriority[level] < levelPriority[minimumLevel]) return;
      const event = fields.event;
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level,
        service,
        environment,
        event: typeof event === "string" && opaqueValue.test(event) ? event : "redacted_event",
      };

      for (const key of allowedOptionalFields) {
        const value = safeValue(key, fields[key]);
        if (value !== undefined) record[key] = value;
      }

      writeLine(JSON.stringify(record));
    },
  };
}
