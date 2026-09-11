CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "brief_revision_status" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'WITHDRAWN'
);
CREATE TYPE "brief_revision_creator" AS ENUM ('HUMAN', 'MODEL');

CREATE TABLE "briefs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "purpose" text DEFAULT 'DISCOVERY' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "briefs_case_fk" FOREIGN KEY ("organization_id", "case_id")
    REFERENCES "prospect_cases" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "briefs_membership_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "briefs_purpose_unique" UNIQUE ("organization_id", "case_id", "purpose"),
  CONSTRAINT "briefs_purpose_check" CHECK ("purpose" = 'DISCOVERY')
);

CREATE TABLE "brief_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "base_revision_id" uuid,
  "status" "brief_revision_status" DEFAULT 'DRAFT' NOT NULL,
  "is_candidate" boolean DEFAULT true NOT NULL,
  "snapshot" jsonb NOT NULL,
  "snapshot_hash" text NOT NULL,
  "knowledge_version" integer NOT NULL,
  "template_id" text NOT NULL,
  "template_version" integer NOT NULL,
  "policy_version" integer NOT NULL,
  "creator" "brief_revision_creator" NOT NULL,
  "created_by_user_id" text,
  "model_invocation_id" uuid,
  "reason" text NOT NULL,
  "material" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brief_revisions_brief_fk" FOREIGN KEY ("organization_id", "case_id", "brief_id")
    REFERENCES "briefs" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_revisions_operator_fk" FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "operator_memberships" ("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "brief_revisions_invocation_fk" FOREIGN KEY
    ("organization_id", "case_id", "model_invocation_id")
    REFERENCES "model_invocations" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_revisions_membership_unique" UNIQUE
    ("organization_id", "case_id", "brief_id", "id"),
  CONSTRAINT "brief_revisions_number_unique" UNIQUE
    ("organization_id", "brief_id", "revision_number"),
  CONSTRAINT "brief_revisions_values_check" CHECK (
    "revision_number" > 0 AND "knowledge_version" > 0
    AND "template_version" > 0 AND "policy_version" > 0
    AND jsonb_typeof("snapshot") = 'object' AND length("snapshot_hash") = 64
    AND "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "snapshot_hash" = encode(digest("snapshot"::text, 'sha256'), 'hex')
    AND length("template_id") > 0 AND length("reason") > 0
    AND (("revision_number" = 1 AND "base_revision_id" IS NULL)
      OR ("revision_number" > 1 AND "base_revision_id" IS NOT NULL))
    AND (("creator" = 'HUMAN' AND "created_by_user_id" IS NOT NULL AND "model_invocation_id" IS NULL)
      OR ("creator" = 'MODEL' AND "created_by_user_id" IS NULL AND "model_invocation_id" IS NOT NULL))
    AND (NOT "is_candidate" OR "status" IN ('DRAFT', 'IN_REVIEW', 'APPROVED'))
  )
);
ALTER TABLE "brief_revisions" ADD CONSTRAINT "brief_revisions_base_fk"
  FOREIGN KEY ("organization_id", "case_id", "brief_id", "base_revision_id")
  REFERENCES "brief_revisions" ("organization_id", "case_id", "brief_id", "id")
  ON DELETE RESTRICT;
CREATE UNIQUE INDEX "brief_revisions_candidate_unique" ON "brief_revisions"
  ("organization_id", "brief_id") WHERE "is_candidate";
CREATE INDEX "brief_revisions_case_idx" ON "brief_revisions"
  ("organization_id", "case_id", "created_at");

CREATE TABLE "brief_revision_claims" (
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "claim_content_hash" text NOT NULL,
  "claim_validity" "claim_validity" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brief_revision_claims_revision_fk" FOREIGN KEY
    ("organization_id", "case_id", "brief_id", "revision_id")
    REFERENCES "brief_revisions" ("organization_id", "case_id", "brief_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "brief_revision_claims_claim_fk" FOREIGN KEY
    ("organization_id", "case_id", "claim_id")
    REFERENCES "claims" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_revision_claims_pk" PRIMARY KEY
    ("organization_id", "revision_id", "claim_id"),
  CONSTRAINT "brief_revision_claims_position_unique" UNIQUE
    ("organization_id", "revision_id", "position"),
  CONSTRAINT "brief_revision_claims_values_check" CHECK (
    "position" >= 0 AND length("claim_content_hash") = 64
    AND "claim_content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE FUNCTION validate_brief_revision_claim_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_hash text;
  current_validity "claim_validity";
BEGIN
  SELECT encode(digest("content", 'sha256'), 'hex'), "validity"
    INTO current_hash, current_validity
    FROM "claims"
    WHERE "organization_id" = NEW."organization_id"
      AND "case_id" = NEW."case_id" AND "id" = NEW."claim_id";
  IF current_hash IS NULL OR NEW."claim_content_hash" <> current_hash
    OR NEW."claim_validity" <> current_validity THEN
    RAISE EXCEPTION 'brief revision claim snapshot does not match claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_revision_claims_exact_snapshot BEFORE INSERT ON "brief_revision_claims"
  FOR EACH ROW EXECUTE FUNCTION validate_brief_revision_claim_snapshot();

CREATE FUNCTION protect_brief_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'brief identity is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER briefs_immutable BEFORE UPDATE OR DELETE ON "briefs"
  FOR EACH ROW EXECUTE FUNCTION protect_brief_identity();

CREATE FUNCTION protect_brief_revision_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."case_id" IS DISTINCT FROM OLD."case_id"
    OR NEW."brief_id" IS DISTINCT FROM OLD."brief_id"
    OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
    OR NEW."base_revision_id" IS DISTINCT FROM OLD."base_revision_id"
    OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
    OR NEW."snapshot_hash" IS DISTINCT FROM OLD."snapshot_hash"
    OR NEW."knowledge_version" IS DISTINCT FROM OLD."knowledge_version"
    OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
    OR NEW."template_version" IS DISTINCT FROM OLD."template_version"
    OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
    OR NEW."creator" IS DISTINCT FROM OLD."creator"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."model_invocation_id" IS DISTINCT FROM OLD."model_invocation_id"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."material" IS DISTINCT FROM OLD."material"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'brief revision snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_revisions_snapshot_immutable BEFORE UPDATE OR DELETE ON "brief_revisions"
  FOR EACH ROW EXECUTE FUNCTION protect_brief_revision_snapshot();

CREATE FUNCTION reject_brief_revision_claim_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'brief revision claim is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER brief_revision_claims_immutable BEFORE UPDATE OR DELETE ON "brief_revision_claims"
  FOR EACH ROW EXECUTE FUNCTION reject_brief_revision_claim_mutation();
