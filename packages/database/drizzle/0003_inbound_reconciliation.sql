CREATE TYPE "inbox_item_kind" AS ENUM ('MESSAGE', 'STATUS', 'UNSUPPORTED');
CREATE TYPE "inbox_item_status" AS ENUM ('PENDING', 'ASSOCIATED', 'AMBIGUOUS', 'UNMATCHED', 'PROCESSED');
CREATE TYPE "provider_delivery_status" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED', 'DELETED');
ALTER TYPE "inbox_status" ADD VALUE 'PROCESSING' AFTER 'RECEIVED';
--> statement-breakpoint
ALTER TABLE "contact_points" ADD COLUMN "provider" text;
ALTER TABLE "contact_points" ADD COLUMN "external_id" text;
CREATE UNIQUE INDEX "contact_points_provider_external_unique"
  ON "contact_points" ("organization_id", "kind", "provider", "external_id")
  WHERE "provider" IS NOT NULL AND "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "inbox_event_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inbox_event_id" uuid NOT NULL REFERENCES "inbox_events"("id") ON DELETE RESTRICT,
  "organization_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL,
  "item_key" text NOT NULL,
  "kind" "inbox_item_kind" NOT NULL,
  "provider_message_id" text,
  "sender_external_id" text,
  "reply_to_provider_message_id" text,
  "message_type" text,
  "text_content" text,
  "provider_occurred_at" timestamptz NOT NULL,
  "received_ordinal" integer NOT NULL,
  "status" "inbox_item_status" NOT NULL DEFAULT 'PENDING',
  "case_id" uuid,
  "conversation_id" uuid,
  "reason_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbox_event_items_connection_membership_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "inbox_event_items_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "inbox_event_items_conversation_membership_fk" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "inbox_event_items_unique" UNIQUE ("provider_connection_id", "item_key"),
  CONSTRAINT "inbox_event_items_ordinal_nonnegative" CHECK ("received_ordinal" >= 0)
);
CREATE INDEX "inbox_event_items_reconcile_idx" ON "inbox_event_items" ("status", "provider_occurred_at", "received_ordinal");
--> statement-breakpoint
CREATE TABLE "media_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inbox_item_id" uuid NOT NULL UNIQUE REFERENCES "inbox_event_items"("id") ON DELETE RESTRICT,
  "provider_media_id" text NOT NULL,
  "media_type" text NOT NULL,
  "mime_type" text,
  "filename" text,
  "sha256" text,
  "restricted" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "media_references_provider_id_not_empty" CHECK (length("provider_media_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "message_status_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL,
  "provider_message_id" text NOT NULL,
  "status" "provider_delivery_status" NOT NULL,
  "provider_occurred_at" timestamptz NOT NULL,
  "inbox_item_id" uuid NOT NULL REFERENCES "inbox_event_items"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "message_status_observations_connection_membership_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "message_status_observations_unique" UNIQUE ("provider_connection_id", "provider_message_id", "status", "provider_occurred_at")
);
CREATE INDEX "message_status_observations_message_idx" ON "message_status_observations" ("provider_connection_id", "provider_message_id", "provider_occurred_at");
