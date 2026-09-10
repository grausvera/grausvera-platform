CREATE TYPE "consent_purpose" AS ENUM ('DISCOVERY');
CREATE TYPE "consent_action" AS ENUM ('ACCEPTED', 'REJECTED', 'REVOKED');
CREATE TYPE "consent_scope" AS ENUM ('PROJECT_DISCOVERY');
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_membership_unique"
  UNIQUE ("organization_id", "case_id", "id");
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_person_membership_unique"
  UNIQUE ("organization_id", "person_id", "id");
--> statement-breakpoint
CREATE TABLE "consent_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "purpose" "consent_purpose" NOT NULL,
  "channel" "contact_kind" NOT NULL,
  "locale" text NOT NULL,
  "version" integer NOT NULL,
  "notice_text" text NOT NULL,
  "notice_hash" text NOT NULL,
  "scope" "consent_scope" NOT NULL DEFAULT 'PROJECT_DISCOVERY',
  "effective_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "consent_policies_identity_unique" UNIQUE ("organization_id", "id", "purpose", "version", "notice_hash", "channel", "locale", "scope"),
  CONSTRAINT "consent_policies_version_unique" UNIQUE ("organization_id", "purpose", "channel", "locale", "version"),
  CONSTRAINT "consent_policies_whatsapp_only" CHECK ("channel" = 'WHATSAPP'),
  CONSTRAINT "consent_policies_version_positive" CHECK ("version" > 0),
  CONSTRAINT "consent_policies_notice_not_empty" CHECK (length("notice_text") > 0),
  CONSTRAINT "consent_policies_hash_sha256" CHECK ("notice_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "consent_policies_locale_not_empty" CHECK (length("locale") > 0),
  CONSTRAINT "consent_policies_window_valid" CHECK ("expires_at" IS NULL OR "expires_at" > "effective_at")
);
CREATE INDEX "consent_policies_effective_idx"
  ON "consent_policies" ("organization_id", "purpose", "channel", "locale", "effective_at");
--> statement-breakpoint
CREATE TABLE "consent_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "purpose" "consent_purpose" NOT NULL,
  "action" "consent_action" NOT NULL,
  "source_message_id" uuid NOT NULL,
  "policy_version" integer NOT NULL,
  "notice_hash" text NOT NULL,
  "channel" "contact_kind" NOT NULL,
  "locale" text NOT NULL,
  "scope" "consent_scope" NOT NULL DEFAULT 'PROJECT_DISCOVERY',
  "occurred_at" timestamptz NOT NULL,
  "valid_until" timestamptz,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "consent_records_case_membership_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_records_person_membership_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_records_contact_person_fk" FOREIGN KEY ("organization_id", "person_id", "contact_point_id") REFERENCES "contact_points"("organization_id", "person_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_records_policy_exact_fk" FOREIGN KEY ("organization_id", "policy_id", "purpose", "policy_version", "notice_hash", "channel", "locale", "scope") REFERENCES "consent_policies"("organization_id", "id", "purpose", "version", "notice_hash", "channel", "locale", "scope") ON DELETE RESTRICT,
  CONSTRAINT "consent_records_source_case_fk" FOREIGN KEY ("organization_id", "case_id", "source_message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "consent_records_idempotency_unique" UNIQUE ("organization_id", "case_id", "idempotency_key"),
  CONSTRAINT "consent_records_whatsapp_only" CHECK ("channel" = 'WHATSAPP'),
  CONSTRAINT "consent_records_version_positive" CHECK ("policy_version" > 0),
  CONSTRAINT "consent_records_hash_sha256" CHECK ("notice_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "consent_records_locale_not_empty" CHECK (length("locale") > 0),
  CONSTRAINT "consent_records_validity_window" CHECK ("valid_until" IS NULL OR "valid_until" > "occurred_at")
);
CREATE INDEX "consent_records_current_idx"
  ON "consent_records" ("organization_id", "case_id", "person_id", "purpose", "occurred_at" DESC);
--> statement-breakpoint
CREATE FUNCTION reject_consent_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent evidence is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER consent_policies_immutable BEFORE UPDATE OR DELETE ON "consent_policies"
FOR EACH ROW EXECUTE FUNCTION reject_consent_evidence_mutation();
CREATE TRIGGER consent_records_immutable BEFORE UPDATE OR DELETE ON "consent_records"
FOR EACH ROW EXECUTE FUNCTION reject_consent_evidence_mutation();
