CREATE TYPE "contact_kind" AS ENUM ('WHATSAPP', 'EMAIL');
CREATE TYPE "participant_role" AS ENUM ('REQUESTER', 'REPRESENTATIVE', 'DECISION_MAKER', 'COLLABORATOR', 'OPERATOR');
CREATE TYPE "case_status" AS ENUM ('NEW', 'AWAITING_CONSENT', 'INTERVIEWING', 'PAUSED', 'NEEDS_INFORMATION', 'READY_FOR_SYNTHESIS', 'SYNTHESIZING', 'ENGINEER_REVIEW', 'AWAITING_EMAIL_VERIFICATION', 'PROSPECT_CONFIRMATION', 'QUALIFIED', 'NOT_A_FIT', 'CLOSED');
CREATE TYPE "provider_kind" AS ENUM ('WHATSAPP', 'EMAIL', 'MODEL', 'OBJECT');
CREATE TYPE "audit_result" AS ENUM ('SUCCEEDED', 'REJECTED', 'FAILED');
--> statement-breakpoint
CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "slug" text NOT NULL UNIQUE,
  "display_name" text NOT NULL, "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organizations_r1_operator_only" CHECK ("slug" = 'grausvera'),
  CONSTRAINT "organizations_version_positive" CHECK ("version" > 0)
);
CREATE TABLE "people" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL DEFAULT 1, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "people_membership_unique" UNIQUE ("organization_id", "id"), CONSTRAINT "people_version_positive" CHECK ("version" > 0)
);
CREATE TABLE "provider_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "kind" "provider_kind" NOT NULL, "external_account_id" text NOT NULL, "credential_reference" text NOT NULL,
  "configuration" jsonb NOT NULL DEFAULT '{}', "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_connections_membership_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "provider_connections_account_unique" UNIQUE ("organization_id", "kind", "external_account_id"),
  CONSTRAINT "provider_connections_version_positive" CHECK ("version" > 0),
  CONSTRAINT "provider_connections_credential_reference_not_empty" CHECK (length("credential_reference") > 0)
);
CREATE TABLE "prospect_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "status" "case_status" NOT NULL DEFAULT 'NEW', "origin" text, "campaign" text, "next_action" text,
  "version" integer NOT NULL DEFAULT 1, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "prospect_cases_membership_unique" UNIQUE ("organization_id", "id"), CONSTRAINT "prospect_cases_version_positive" CHECK ("version" > 0)
);
CREATE INDEX "prospect_cases_status_idx" ON "prospect_cases" ("organization_id", "status");
--> statement-breakpoint
CREATE TABLE "contact_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "person_id" uuid NOT NULL,
  "kind" "contact_kind" NOT NULL, "value_ciphertext" text NOT NULL, "fingerprint" text NOT NULL,
  "source" text NOT NULL, "purpose" text NOT NULL, "verified_at" timestamptz, "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "contact_points_person_membership_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "contact_points_membership_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "contact_points_fingerprint_unique" UNIQUE ("organization_id", "kind", "fingerprint"),
  CONSTRAINT "contact_points_ciphertext_not_empty" CHECK (length("value_ciphertext") > 0),
  CONSTRAINT "contact_points_fingerprint_not_empty" CHECK (length("fingerprint") > 0),
  CONSTRAINT "contact_points_version_positive" CHECK ("version" > 0)
);
CREATE TABLE "case_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "case_id" uuid NOT NULL, "person_id" uuid NOT NULL,
  "role" "participant_role" NOT NULL, "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_participants_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "case_participants_person_membership_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "case_participants_role_unique" UNIQUE ("organization_id", "case_id", "person_id", "role"),
  CONSTRAINT "case_participants_version_positive" CHECK ("version" > 0)
);
CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "case_id" uuid NOT NULL,
  "provider_connection_id" uuid NOT NULL, "channel" "contact_kind" NOT NULL DEFAULT 'WHATSAPP', "external_thread_id" text,
  "version" integer NOT NULL DEFAULT 1, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversations_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "conversations_connection_membership_fk" FOREIGN KEY ("organization_id", "provider_connection_id") REFERENCES "provider_connections"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "conversations_membership_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "conversations_whatsapp_only" CHECK ("channel" = 'WHATSAPP'), CONSTRAINT "conversations_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "conversations_thread_unique" ON "conversations" ("provider_connection_id", "external_thread_id") WHERE "external_thread_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "case_id" uuid, "actor" text NOT NULL, "action" text NOT NULL, "resource_type" text NOT NULL, "resource_id" uuid NOT NULL,
  "expected_version" integer, "result" "audit_result" NOT NULL, "correlation_id" uuid NOT NULL, "origin" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}', "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_events_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT
  ,CONSTRAINT "audit_events_action_not_empty" CHECK (length("action") > 0)
  ,CONSTRAINT "audit_events_resource_type_not_empty" CHECK (length("resource_type") > 0)
  ,CONSTRAINT "audit_events_origin_not_empty" CHECK (length("origin") > 0)
  ,CONSTRAINT "audit_events_expected_version_positive" CHECK ("expected_version" IS NULL OR "expected_version" > 0)
);
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" ("organization_id", "correlation_id");
--> statement-breakpoint
CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
