ALTER TABLE "inbox_events" ADD COLUMN "processing_started_at" timestamptz;
--> statement-breakpoint
UPDATE "inbox_events" SET "status"='RECEIVED',
  "last_error_code"='processing_lease_migrated'
WHERE "status"='PROCESSING';
--> statement-breakpoint
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_processing_lease_check"
  CHECK (("status"='PROCESSING') = ("processing_started_at" IS NOT NULL));
