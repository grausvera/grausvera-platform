import { z } from "zod";

const environmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const roleSchema = z.enum(["web", "worker"]);

const configSchema = z.object({
  APP_ROLE: roleSchema.default("web"),
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
      message: "DATABASE_URL must use postgres or postgresql",
    }),
  LOG_LEVEL: logLevelSchema.default("info"),
  NODE_ENV: environmentSchema.default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(source);
}
