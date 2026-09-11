CREATE TYPE "brief_review_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "brief_approval_status" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

CREATE TABLE "brief_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "reviewer_user_id" text NOT NULL,
  "status" "brief_review_status" DEFAULT 'PENDING' NOT NULL,
  "comments" text,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brief_reviews_revision_fk" FOREIGN KEY
    ("organization_id", "case_id", "brief_id", "revision_id")
    REFERENCES "brief_revisions" ("organization_id", "case_id", "brief_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "brief_reviews_reviewer_fk" FOREIGN KEY ("organization_id", "reviewer_user_id")
    REFERENCES "operator_memberships" ("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "brief_reviews_membership_unique" UNIQUE
    ("organization_id", "case_id", "brief_id", "revision_id", "id"),
  CONSTRAINT "brief_reviews_revision_unique" UNIQUE ("organization_id", "revision_id"),
  CONSTRAINT "brief_reviews_decision_check" CHECK (
    (("status" = 'PENDING' AND "decided_at" IS NULL)
      OR ("status" IN ('APPROVED', 'REJECTED') AND "decided_at" IS NOT NULL))
    AND ("comments" IS NULL OR length(btrim("comments")) > 0)
  )
);
CREATE INDEX "brief_reviews_queue_idx" ON "brief_reviews"
  ("organization_id", "reviewer_user_id", "status", "submitted_at");

CREATE TABLE "brief_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "review_id" uuid NOT NULL,
  "snapshot_hash" text NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "delivery_purpose" text DEFAULT 'BRIEF_DELIVERY' NOT NULL,
  "authentication_method" text NOT NULL,
  "authenticated_at" timestamp with time zone NOT NULL,
  "status" "brief_approval_status" DEFAULT 'ACTIVE' NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brief_approvals_review_fk" FOREIGN KEY
    ("organization_id", "case_id", "brief_id", "revision_id", "review_id")
    REFERENCES "brief_reviews"
      ("organization_id", "case_id", "brief_id", "revision_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_approvals_operator_fk" FOREIGN KEY
    ("organization_id", "approved_by_user_id")
    REFERENCES "operator_memberships" ("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "brief_approvals_membership_unique" UNIQUE
    ("organization_id", "case_id", "brief_id", "revision_id", "id"),
  CONSTRAINT "brief_approvals_values_check" CHECK (
    length("snapshot_hash") = 64 AND "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "delivery_purpose" = 'BRIEF_DELIVERY'
    AND "authentication_method" = 'PASSWORD_TOTP'
    AND "authenticated_at" <= "approved_at"
    AND ("expires_at" IS NULL OR "expires_at" > "approved_at")
    AND (("status" = 'ACTIVE' AND "revoked_at" IS NULL)
      OR ("status" IN ('REVOKED', 'EXPIRED') AND "revoked_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "brief_approvals_active_unique" ON "brief_approvals"
  ("organization_id", "revision_id", "delivery_purpose") WHERE "status" = 'ACTIVE';
CREATE INDEX "brief_approvals_case_idx" ON "brief_approvals"
  ("organization_id", "case_id", "status", "approved_at");

CREATE FUNCTION validate_brief_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_status "brief_revision_status";
  candidate boolean;
BEGIN
  SELECT "status", "is_candidate" INTO revision_status, candidate
    FROM "brief_revisions" WHERE "organization_id" = NEW."organization_id"
      AND "case_id" = NEW."case_id" AND "brief_id" = NEW."brief_id"
      AND "id" = NEW."revision_id";
  IF revision_status IS DISTINCT FROM 'IN_REVIEW' OR candidate IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'review requires the current in-review revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_reviews_exact_revision BEFORE INSERT ON "brief_reviews"
  FOR EACH ROW EXECUTE FUNCTION validate_brief_review();

CREATE FUNCTION protect_brief_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" <> 'PENDING'
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."case_id" IS DISTINCT FROM OLD."case_id"
    OR NEW."brief_id" IS DISTINCT FROM OLD."brief_id"
    OR NEW."revision_id" IS DISTINCT FROM OLD."revision_id"
    OR NEW."reviewer_user_id" IS DISTINCT FROM OLD."reviewer_user_id"
    OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."status" NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'brief review decision is immutable or invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_reviews_decision_transition BEFORE UPDATE OR DELETE ON "brief_reviews"
  FOR EACH ROW EXECUTE FUNCTION protect_brief_review_decision();

CREATE FUNCTION validate_brief_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_status "brief_review_status";
  revision_status "brief_revision_status";
  revision_hash text;
  candidate boolean;
BEGIN
  SELECT r."status", br."status", br."snapshot_hash", br."is_candidate"
    INTO review_status, revision_status, revision_hash, candidate
    FROM "brief_reviews" r JOIN "brief_revisions" br
      ON br."organization_id" = r."organization_id" AND br."case_id" = r."case_id"
      AND br."brief_id" = r."brief_id" AND br."id" = r."revision_id"
    WHERE r."organization_id" = NEW."organization_id" AND r."case_id" = NEW."case_id"
      AND r."brief_id" = NEW."brief_id" AND r."revision_id" = NEW."revision_id"
      AND r."id" = NEW."review_id" FOR UPDATE OF r, br;
  IF review_status IS DISTINCT FROM 'APPROVED' OR revision_status IS DISTINCT FROM 'IN_REVIEW'
    OR candidate IS DISTINCT FROM true OR revision_hash IS DISTINCT FROM NEW."snapshot_hash"
    OR NEW."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'approval does not match an approved review and current revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_approvals_exact_review BEFORE INSERT ON "brief_approvals"
  FOR EACH ROW EXECUTE FUNCTION validate_brief_approval();

CREATE FUNCTION protect_brief_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" <> 'ACTIVE'
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."case_id" IS DISTINCT FROM OLD."case_id"
    OR NEW."brief_id" IS DISTINCT FROM OLD."brief_id"
    OR NEW."revision_id" IS DISTINCT FROM OLD."revision_id"
    OR NEW."review_id" IS DISTINCT FROM OLD."review_id"
    OR NEW."snapshot_hash" IS DISTINCT FROM OLD."snapshot_hash"
    OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
    OR NEW."delivery_purpose" IS DISTINCT FROM OLD."delivery_purpose"
    OR NEW."authentication_method" IS DISTINCT FROM OLD."authentication_method"
    OR NEW."authenticated_at" IS DISTINCT FROM OLD."authenticated_at"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."status" NOT IN ('REVOKED', 'EXPIRED') THEN
    RAISE EXCEPTION 'brief approval is immutable or transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_approvals_transition BEFORE UPDATE OR DELETE ON "brief_approvals"
  FOR EACH ROW EXECUTE FUNCTION protect_brief_approval();

CREATE FUNCTION validate_brief_revision_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('IN_REVIEW', 'SUPERSEDED', 'WITHDRAWN'))
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'SUPERSEDED', 'WITHDRAWN'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SUPERSEDED', 'WITHDRAWN'))) THEN
      RAISE EXCEPTION 'invalid brief revision transition' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'APPROVED' AND NOT EXISTS (
      SELECT 1 FROM "brief_approvals" a WHERE a."organization_id" = NEW."organization_id"
        AND a."case_id" = NEW."case_id" AND a."brief_id" = NEW."brief_id"
        AND a."revision_id" = NEW."id" AND a."snapshot_hash" = NEW."snapshot_hash"
        AND a."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'approved revision requires an active exact approval' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD."is_candidate" = false AND NEW."is_candidate" = true THEN
    RAISE EXCEPTION 'superseded revision cannot become candidate' USING ERRCODE = '23514';
  END IF;
  IF OLD."is_candidate" = true AND NEW."is_candidate" = false
    AND NEW."status" NOT IN ('SUPERSEDED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'candidate removal requires terminal revision state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_revisions_valid_transition BEFORE UPDATE ON "brief_revisions"
  FOR EACH ROW EXECUTE FUNCTION validate_brief_revision_transition();
