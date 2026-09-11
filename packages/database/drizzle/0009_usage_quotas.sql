CREATE TABLE "quota_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "period_seconds" integer NOT NULL,
  "case_message_limit" integer NOT NULL,
  "contact_message_limit" integer NOT NULL,
  "case_active_seconds_limit" integer NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quota_policies_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "quota_policies_version_unique" UNIQUE ("organization_id", "version"),
  CONSTRAINT "quota_policies_limits_positive" CHECK ("version" > 0 AND "period_seconds" > 0 AND "case_message_limit" > 0 AND "contact_message_limit" > 0 AND "case_active_seconds_limit" > 0)
);

CREATE TABLE "case_quota_usages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL REFERENCES "quota_policies"("id") ON DELETE RESTRICT,
  "window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "window_ends_at" timestamp with time zone NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "active_seconds" integer DEFAULT 0 NOT NULL,
  "last_accounted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "exceeded_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "case_quota_usages_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "case_quota_usages_unique" UNIQUE ("organization_id", "case_id", "policy_id"),
  CONSTRAINT "case_quota_usages_nonnegative" CHECK ("message_count" >= 0 AND "active_seconds" >= 0),
  CONSTRAINT "case_quota_usages_window_valid" CHECK ("window_ends_at" > "window_started_at")
);

CREATE TABLE "contact_quota_usages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL REFERENCES "quota_policies"("id") ON DELETE RESTRICT,
  "window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "window_ends_at" timestamp with time zone NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "exceeded_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contact_quota_usages_contact_fk" FOREIGN KEY ("organization_id", "contact_point_id") REFERENCES "contact_points"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "contact_quota_usages_unique" UNIQUE ("organization_id", "contact_point_id", "policy_id"),
  CONSTRAINT "contact_quota_usages_nonnegative" CHECK ("message_count" >= 0),
  CONSTRAINT "contact_quota_usages_window_valid" CHECK ("window_ends_at" > "window_started_at")
);

CREATE TABLE "quota_consumptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE RESTRICT,
  "case_usage_id" uuid NOT NULL REFERENCES "case_quota_usages"("id") ON DELETE RESTRICT,
  "contact_usage_id" uuid NOT NULL REFERENCES "contact_quota_usages"("id") ON DELETE RESTRICT,
  "exceeded" boolean DEFAULT false NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quota_consumptions_message_unique" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "quota_consumptions_reason_check" CHECK (("exceeded" AND "reason" IS NOT NULL) OR (NOT "exceeded" AND "reason" IS NULL))
);

CREATE INDEX "quota_policies_effective_idx" ON "quota_policies" ("organization_id", "effective_at");
CREATE INDEX "case_quota_usages_window_idx" ON "case_quota_usages" ("organization_id", "window_ends_at");
CREATE INDEX "contact_quota_usages_window_idx" ON "contact_quota_usages" ("organization_id", "window_ends_at");

CREATE FUNCTION reject_quota_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quota evidence is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER quota_policies_immutable BEFORE UPDATE OR DELETE ON "quota_policies"
FOR EACH ROW EXECUTE FUNCTION reject_quota_evidence_mutation();
CREATE TRIGGER quota_consumptions_immutable BEFORE UPDATE OR DELETE ON "quota_consumptions"
FOR EACH ROW EXECUTE FUNCTION reject_quota_evidence_mutation();
