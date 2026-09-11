ALTER TABLE "retention_actions" DROP CONSTRAINT "retention_actions_subject_not_empty";
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_subject_not_empty"
  CHECK ("opaque_subject_id" ~ '^[0-9a-f]{64}$');
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_scope_array"
  CHECK (jsonb_typeof("scope") = 'array');
--> statement-breakpoint
CREATE FUNCTION protect_retention_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
    OR NEW.privacy_request_id <> OLD.privacy_request_id
    OR NEW.opaque_subject_id <> OLD.opaque_subject_id OR NEW.scope <> OLD.scope
    OR NEW.cutoff_at <> OLD.cutoff_at OR NEW.integrity_hash <> OLD.integrity_hash
    OR (OLD.journal_checkpoint IS NOT NULL AND NEW.journal_checkpoint IS DISTINCT FROM OLD.journal_checkpoint)
    OR (OLD.journal_confirmed_at IS NOT NULL AND NEW.journal_confirmed_at IS DISTINCT FROM OLD.journal_confirmed_at)
    OR NOT (
      NEW.status = OLD.status OR
      (OLD.status='JOURNAL_PENDING' AND NEW.status='JOURNALED') OR
      (OLD.status='JOURNALED' AND NEW.status='EXECUTING') OR
      (OLD.status='EXECUTING' AND NEW.status='COMPLETED')
    ) THEN
    RAISE EXCEPTION 'retention action is immutable or has an invalid transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retention_actions_protected BEFORE UPDATE ON "retention_actions"
FOR EACH ROW EXECUTE FUNCTION protect_retention_action();
