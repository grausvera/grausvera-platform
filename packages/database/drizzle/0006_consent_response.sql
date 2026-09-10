ALTER TABLE "messages" ADD COLUMN "sender_person_id" uuid;
ALTER TABLE "messages" ADD COLUMN "sender_contact_point_id" uuid;
ALTER TABLE "messages" ADD COLUMN "reply_to_provider_message_id" text;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_contact_fk"
  FOREIGN KEY ("organization_id", "sender_person_id", "sender_contact_point_id")
  REFERENCES "contact_points"("organization_id", "person_id", "id") ON DELETE RESTRICT;
CREATE INDEX "messages_reply_idx"
  ON "messages" ("provider_connection_id", "reply_to_provider_message_id")
  WHERE "reply_to_provider_message_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_source_unique"
  UNIQUE ("organization_id", "source_message_id", "purpose");
