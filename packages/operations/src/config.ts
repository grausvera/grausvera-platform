import { z } from "zod";

const environmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const roleSchema = z.enum(["web", "worker"]);
const booleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const configSchema = z.object({
  APP_ROLE: roleSchema.default("web"),
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
      message: "DATABASE_URL must use postgres or postgresql",
    }),
  LOG_LEVEL: logLevelSchema.default("info"),
  OBJECT_STORAGE_ROOT: z.string().min(1).default(".data/objects"),
  EMAIL_EMITTER_ENABLED: booleanSchema.default(false),
  EMAIL_SECRET_KEY_BASE64: z.string().min(1).optional(),
  EMAIL_SECRET_KEY_REFERENCE: z.string().min(1).default("email-transient-v1"),
  MESSAGING_EMITTER_ENABLED: booleanSchema.default(false),
  META_ACCESS_TOKEN: z.string().min(1).optional(),
  META_GRAPH_BASE_URL: z.url().default("https://graph.facebook.com"),
  META_PHONE_NUMBER_ID: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_BASE_URL: z.url().default("https://api.resend.com"),
  RESEND_FROM: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  NODE_ENV: environmentSchema.default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = configSchema.parse(source);
  if (
    config.MESSAGING_EMITTER_ENABLED &&
    (!config.META_ACCESS_TOKEN || !config.META_PHONE_NUMBER_ID)
  ) {
    throw new Error("Meta messaging configuration is required when the emitter is enabled");
  }
  if (
    config.EMAIL_EMITTER_ENABLED &&
    (!config.EMAIL_SECRET_KEY_BASE64 || !config.RESEND_API_KEY || !config.RESEND_FROM)
  ) {
    throw new Error("Email configuration is required when the emitter is enabled");
  }
  if (
    config.EMAIL_SECRET_KEY_BASE64 &&
    Buffer.from(config.EMAIL_SECRET_KEY_BASE64, "base64").byteLength !== 32
  ) {
    throw new Error("EMAIL_SECRET_KEY_BASE64 must decode to 32 bytes");
  }
  return config;
}
