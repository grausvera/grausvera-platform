ALTER TABLE "interviews" ADD COLUMN "active_seconds" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "interviews" ADD COLUMN "active_started_at" timestamp with time zone DEFAULT now();
ALTER TABLE "interviews" ADD COLUMN "paused_at" timestamp with time zone;
ALTER TABLE "interviews" ADD COLUMN "pause_reason" text;
ALTER TABLE "interviews" ADD COLUMN "resume_case_status" "case_status";
ALTER TABLE "interviews" ADD COLUMN "resume_next_action" text;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_pause_state_check" CHECK (
  "active_seconds" >= 0
  AND (("paused_at" IS NULL AND "pause_reason" IS NULL) OR ("paused_at" IS NOT NULL AND length("pause_reason") > 0))
);
