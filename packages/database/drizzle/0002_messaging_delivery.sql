CREATE TYPE "inbox_status" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'NEEDS_ACTION');
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "message_processing_status" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'NEEDS_ACTION');
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'DISPATCHING', 'ACCEPTED', 'UNCERTAIN', 'NEEDS_ACTION', 'FAILED', 'CANCELLED');
CREATE TYPE "delivery_attempt_outcome" AS ENUM ('ACCEPTED', 'REJECTED_TRANSIENT', 'REJECTED_PERMANENT', 'UNCERTAIN');
--> statement-breakpoint
CREATE TABLE "inbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL,
  "external_event_id" text NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "payload_bytes" bytea NOT NULL,
  "payload_hash" text NOT NULL,
  "status" "inbox_status" NOT NULL DEFAULT 'RECEIVED',
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  CONSTRAINT "inbox_events_connection_membership_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "inbox_events_external_unique" UNIQUE ("provider_connection_id", "external_event_id"),
  CONSTRAINT "inbox_events_schema_version_positive" CHECK ("schema_version" > 0),
  CONSTRAINT "inbox_events_attempts_nonnegative" CHECK ("attempts" >= 0),
  CONSTRAINT "inbox_events_payload_hash_not_empty" CHECK (length("payload_hash") > 0)
);
CREATE INDEX "inbox_events_pending_idx" ON "inbox_events" ("status", "received_at");
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL,
  "direction" "message_direction" NOT NULL,
  "provider_message_id" text NOT NULL,
  "message_type" text NOT NULL,
  "content_bytes" bytea,
  "content_hash" text,
  "provider_occurred_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processing_status" "message_processing_status" NOT NULL DEFAULT 'RECEIVED',
  CONSTRAINT "messages_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "messages_conversation_membership_fk" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "messages_connection_membership_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "messages_provider_unique" UNIQUE ("provider_connection_id", "provider_message_id")
);
CREATE INDEX "messages_conversation_order_idx" ON "messages" ("organization_id", "conversation_id", "provider_occurred_at", "received_at");
--> statement-breakpoint
CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "idempotency_key" text NOT NULL,
  "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "deadline_at" timestamptz NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "locked_at" timestamptz,
  "provider_external_id" text,
  "last_error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outbox_events_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "outbox_events_idempotency_unique" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "outbox_events_schema_version_positive" CHECK ("schema_version" > 0),
  CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0),
  CONSTRAINT "outbox_events_deadline_valid" CHECK ("deadline_at" > "created_at")
);
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events" ("status", "available_at", "created_at");
--> statement-breakpoint
CREATE TABLE "message_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "outbox_event_id" uuid NOT NULL REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "attempt_number" integer NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "outcome" "delivery_attempt_outcome",
  "provider_external_id" text,
  "error_code" text,
  CONSTRAINT "message_delivery_attempts_number_unique" UNIQUE ("outbox_event_id", "attempt_number"),
  CONSTRAINT "message_delivery_attempts_number_positive" CHECK ("attempt_number" > 0)
);
--> statement-breakpoint
CREATE FUNCTION reject_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'messages are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON "messages"
FOR EACH ROW EXECUTE FUNCTION reject_message_mutation();
