CREATE TYPE "attachment_status" AS ENUM ('QUARANTINED', 'REVIEWED', 'REJECTED');

CREATE TABLE "attachment_circuit_breakers" (
  "organization_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "open_until" timestamp with time zone,
  "probe_in_flight" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attachment_circuit_breakers_pk" PRIMARY KEY ("organization_id", "provider_connection_id"),
  CONSTRAINT "attachment_circuit_breakers_provider_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "attachment_circuit_breakers_failures_check" CHECK ("consecutive_failures" >= 0)
);

CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "media_reference_id" uuid NOT NULL REFERENCES "media_references"("id") ON DELETE RESTRICT,
  "object_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "status" "attachment_status" DEFAULT 'QUARANTINED' NOT NULL,
  "reviewed_by_user_id" text,
  "reviewed_at" timestamp with time zone,
  "rejection_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attachments_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "attachments_reviewer_fk" FOREIGN KEY ("organization_id", "reviewed_by_user_id") REFERENCES "operator_memberships"("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "attachments_media_unique" UNIQUE ("organization_id", "media_reference_id"),
  CONSTRAINT "attachments_object_key_unique" UNIQUE ("object_key"),
  CONSTRAINT "attachments_values_check" CHECK ("size_bytes" > 0 AND length("object_key") > 0 AND length("sha256") = 64),
  CONSTRAINT "attachments_review_check" CHECK (("status" = 'QUARANTINED' AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL) OR ("status" <> 'QUARANTINED' AND "reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
  CONSTRAINT "attachments_rejection_check" CHECK (("status" = 'REJECTED' AND "rejection_reason" IS NOT NULL) OR ("status" <> 'REJECTED' AND "rejection_reason" IS NULL))
);
CREATE INDEX "attachments_review_queue_idx" ON "attachments" ("organization_id", "status", "created_at");
