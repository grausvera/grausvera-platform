CREATE TYPE "privacy_request_kind" AS ENUM ('ACCESS_EXPORT','RECTIFICATION','ERASURE');
CREATE TYPE "privacy_request_status" AS ENUM ('IN_PROGRESS','COMPLETED','REJECTED');
CREATE TYPE "retention_action_status" AS ENUM ('JOURNAL_PENDING','JOURNALED','EXECUTING','COMPLETED');
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL, "person_id" uuid NOT NULL, "kind" privacy_request_kind NOT NULL,
  "status" privacy_request_status NOT NULL DEFAULT 'IN_PROGRESS', "requested_by_user_id" text NOT NULL,
  "identity_verified_at" timestamptz NOT NULL, "scope" jsonb NOT NULL DEFAULT '{}',
  "idempotency_key" text NOT NULL, "completed_at" timestamptz, "rejection_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "privacy_requests_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "prospect_cases"("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "privacy_requests_person_fk" FOREIGN KEY ("organization_id","person_id") REFERENCES "people"("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "privacy_requests_operator_fk" FOREIGN KEY ("organization_id","requested_by_user_id") REFERENCES "operator_memberships"("organization_id","user_id") ON DELETE RESTRICT,
  CONSTRAINT "privacy_requests_idempotency_unique" UNIQUE ("organization_id","idempotency_key"),
  CONSTRAINT "privacy_requests_membership_unique" UNIQUE ("organization_id","case_id","id"),
  CONSTRAINT "privacy_requests_idempotency_not_empty" CHECK (length(btrim("idempotency_key")) > 0),
  CONSTRAINT "privacy_requests_lifecycle_check" CHECK (
    ("status"='IN_PROGRESS' AND "completed_at" IS NULL AND "rejection_reason" IS NULL) OR
    ("status"='COMPLETED' AND "completed_at" IS NOT NULL AND "rejection_reason" IS NULL) OR
    ("status"='REJECTED' AND "completed_at" IS NOT NULL AND length(btrim("rejection_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "retention_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL, "privacy_request_id" uuid NOT NULL,
  "status" retention_action_status NOT NULL DEFAULT 'JOURNAL_PENDING',
  "opaque_subject_id" text NOT NULL, "scope" jsonb NOT NULL DEFAULT '{}',
  "cutoff_at" timestamptz NOT NULL, "integrity_hash" text NOT NULL,
  "journal_checkpoint" text, "journal_confirmed_at" timestamptz, "last_error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "retention_actions_request_fk" FOREIGN KEY ("organization_id","case_id","privacy_request_id") REFERENCES "privacy_requests"("organization_id","case_id","id") ON DELETE RESTRICT,
  CONSTRAINT "retention_actions_request_unique" UNIQUE ("privacy_request_id"),
  CONSTRAINT "retention_actions_subject_not_empty" CHECK (length("opaque_subject_id") = 64),
  CONSTRAINT "retention_actions_integrity_hash" CHECK ("integrity_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "retention_actions_journal_check" CHECK (
    ("status"='JOURNAL_PENDING' AND "journal_checkpoint" IS NULL AND "journal_confirmed_at" IS NULL) OR
    ("status" IN ('JOURNALED','EXECUTING','COMPLETED') AND length("journal_checkpoint") > 0 AND "journal_confirmed_at" IS NOT NULL))
);
CREATE INDEX "retention_actions_status_idx" ON "retention_actions" ("status","created_at");
--> statement-breakpoint
CREATE FUNCTION reject_privacy_request_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
    OR NEW.person_id <> OLD.person_id OR NEW.kind <> OLD.kind
    OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.identity_verified_at <> OLD.identity_verified_at OR NEW.scope <> OLD.scope
    OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'privacy request identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_requests_identity_immutable BEFORE UPDATE ON "privacy_requests"
FOR EACH ROW EXECUTE FUNCTION reject_privacy_request_identity_mutation();
