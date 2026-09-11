ALTER TYPE "interview_topic_status" ADD VALUE 'DECLARED_UNKNOWN';

ALTER TABLE "interviews" ADD COLUMN "brief_requested_at" timestamp with time zone;
ALTER TABLE "interviews" ADD COLUMN "brief_request_message_id" uuid;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_brief_request_message_fk"
  FOREIGN KEY ("organization_id", "case_id", "brief_request_message_id")
  REFERENCES "messages" ("organization_id", "case_id", "id") ON DELETE RESTRICT;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_brief_request_check"
  CHECK (("brief_requested_at" IS NULL) = ("brief_request_message_id" IS NULL));
