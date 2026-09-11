CREATE TABLE "retention_disposition_steps" (
  "action_id" uuid NOT NULL REFERENCES "retention_actions"("id") ON DELETE RESTRICT,
  "step" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "disposed_count" integer NOT NULL DEFAULT 0,
  "result_checkpoint" text,
  "last_error_code" text,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "retention_disposition_steps_pk" PRIMARY KEY ("action_id","step"),
  CONSTRAINT "retention_disposition_steps_step_check"
    CHECK ("step" IN ('OBJECTS','DATABASE','JOBS','DERIVATIVES','RESULT_JOURNAL')),
  CONSTRAINT "retention_disposition_steps_status_check"
    CHECK ("status" IN ('PENDING','COMPLETED') AND "attempts" >= 0 AND "disposed_count" >= 0
      AND (("status"='PENDING' AND "completed_at" IS NULL)
        OR ("status"='COMPLETED' AND "completed_at" IS NOT NULL))
      AND ("step"='RESULT_JOURNAL' OR "result_checkpoint" IS NULL))
);
--> statement-breakpoint
CREATE FUNCTION retention_disposition_authorized(target_organization uuid, target_case uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM retention_actions r
    WHERE r.id = nullif(current_setting('app.retention_action_id', true), '')::uuid
      AND r.organization_id = target_organization AND r.case_id = target_case
      AND r.status = 'EXECUTING' AND r.journal_checkpoint IS NOT NULL
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND retention_disposition_authorized(OLD.organization_id, OLD.case_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'messages are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_brief_revision_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND retention_disposition_authorized(OLD.organization_id, OLD.case_id) THEN
    RETURN NEW;
  END IF;
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
