CREATE TYPE "email_verification_challenge_status" AS ENUM
  ('PENDING', 'CONSUMED', 'REVOKED', 'EXPIRED');

CREATE TABLE "email_verification_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "purpose" text DEFAULT 'BRIEF_DELIVERY' NOT NULL,
  "token_digest" text NOT NULL,
  "status" "email_verification_challenge_status" DEFAULT 'PENDING' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "previous_challenge_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_verification_challenges_case_fk" FOREIGN KEY
    ("organization_id", "case_id") REFERENCES "prospect_cases"
    ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "email_verification_challenges_contact_fk" FOREIGN KEY
    ("organization_id", "contact_point_id") REFERENCES "contact_points"
    ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "email_verification_challenges_previous_fk" FOREIGN KEY
    ("previous_challenge_id") REFERENCES "email_verification_challenges" ("id") ON DELETE RESTRICT,
  CONSTRAINT "email_verification_challenges_digest_unique" UNIQUE
    ("organization_id", "token_digest"),
  CONSTRAINT "email_verification_challenges_values_check" CHECK (
    "purpose" = 'BRIEF_DELIVERY'
    AND length("token_digest") = 64 AND "token_digest" ~ '^[0-9a-f]{64}$'
    AND "attempt_count" BETWEEN 0 AND "max_attempts"
    AND "max_attempts" BETWEEN 1 AND 10
    AND "expires_at" > "created_at"
    AND (("status" = 'PENDING' AND "consumed_at" IS NULL AND "revoked_at" IS NULL)
      OR ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR ("status" IN ('REVOKED','EXPIRED') AND "consumed_at" IS NULL
        AND "revoked_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "email_verification_challenges_pending_unique"
  ON "email_verification_challenges"
  ("organization_id", "case_id", "contact_point_id", "purpose")
  WHERE "status" = 'PENDING';
CREATE INDEX "email_verification_challenges_expiry_idx"
  ON "email_verification_challenges" ("organization_id", "status", "expires_at");

CREATE FUNCTION validate_email_verification_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "contact_points" cp
    JOIN "case_participants" p ON p."organization_id" = cp."organization_id"
      AND p."person_id" = cp."person_id" AND p."case_id" = NEW."case_id"
    WHERE cp."organization_id" = NEW."organization_id"
      AND cp."id" = NEW."contact_point_id" AND cp."kind" = 'EMAIL'
  ) THEN
    RAISE EXCEPTION 'challenge requires an email contact participating in the case'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."previous_challenge_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "email_verification_challenges" previous
    WHERE previous."id" = NEW."previous_challenge_id"
      AND previous."organization_id" = NEW."organization_id"
      AND previous."case_id" = NEW."case_id"
      AND previous."contact_point_id" = NEW."contact_point_id"
      AND previous."purpose" = NEW."purpose" AND previous."status" = 'REVOKED'
  ) THEN
    RAISE EXCEPTION 'replacement challenge does not match a revoked predecessor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_verification_challenges_scope BEFORE INSERT
  ON "email_verification_challenges" FOR EACH ROW
  EXECUTE FUNCTION validate_email_verification_challenge();

CREATE FUNCTION protect_email_verification_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."case_id" IS DISTINCT FROM OLD."case_id"
    OR NEW."contact_point_id" IS DISTINCT FROM OLD."contact_point_id"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."token_digest" IS DISTINCT FROM OLD."token_digest"
    OR NEW."max_attempts" IS DISTINCT FROM OLD."max_attempts"
    OR NEW."previous_challenge_id" IS DISTINCT FROM OLD."previous_challenge_id"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status" <> 'PENDING'
    OR NEW."status" NOT IN ('PENDING','CONSUMED','REVOKED','EXPIRED')
    OR NEW."attempt_count" < OLD."attempt_count"
  THEN
    RAISE EXCEPTION 'email verification challenge is immutable or transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_verification_challenges_transition BEFORE UPDATE OR DELETE
  ON "email_verification_challenges" FOR EACH ROW
  EXECUTE FUNCTION protect_email_verification_challenge();
