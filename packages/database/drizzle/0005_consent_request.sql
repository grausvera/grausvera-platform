CREATE TYPE "consent_request_status" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');
--> statement-breakpoint
CREATE TABLE "consent_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "purpose" "consent_purpose" NOT NULL,
  "policy_version" integer NOT NULL,
  "notice_hash" text NOT NULL,
  "channel" "contact_kind" NOT NULL,
  "locale" text NOT NULL,
  "scope" "consent_scope" NOT NULL,
  "source_message_id" uuid NOT NULL,
  "request_message_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "status" "consent_request_status" NOT NULL DEFAULT 'PENDING',
  "version" integer NOT NULL DEFAULT 1,
  "idempotency_key" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "consent_requests_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_requests_contact_person_fk" FOREIGN KEY ("organization_id", "person_id", "contact_point_id") REFERENCES "contact_points"("organization_id", "person_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_requests_policy_exact_fk" FOREIGN KEY ("organization_id", "policy_id", "purpose", "policy_version", "notice_hash", "channel", "locale", "scope") REFERENCES "consent_policies"("organization_id", "id", "purpose", "version", "notice_hash", "channel", "locale", "scope") ON DELETE RESTRICT,
  CONSTRAINT "consent_requests_source_case_fk" FOREIGN KEY ("organization_id", "case_id", "source_message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_requests_message_case_fk" FOREIGN KEY ("organization_id", "case_id", "request_message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_requests_logical_unique" UNIQUE ("organization_id", "case_id", "person_id", "policy_id"),
  CONSTRAINT "consent_requests_idempotency_unique" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "consent_requests_outbox_unique" UNIQUE ("outbox_event_id"),
  CONSTRAINT "consent_requests_message_unique" UNIQUE ("request_message_id"),
  CONSTRAINT "consent_requests_whatsapp_only" CHECK ("channel" = 'WHATSAPP'),
  CONSTRAINT "consent_requests_expiry_valid" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "consent_requests_version_positive" CHECK ("version" > 0)
);
CREATE INDEX "consent_requests_pending_idx"
  ON "consent_requests" ("organization_id", "status", "expires_at");
