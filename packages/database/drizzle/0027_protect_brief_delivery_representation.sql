CREATE OR REPLACE FUNCTION protect_email_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.brief_id IS DISTINCT FROM OLD.brief_id
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.contact_point_id IS DISTINCT FROM OLD.contact_point_id
    OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.deduplication_expires_at IS DISTINCT FROM OLD.deduplication_expires_at
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR NEW.representation_object_key IS DISTINCT FROM OLD.representation_object_key
    OR NEW.representation_hash IS DISTINCT FROM OLD.representation_hash
    OR NEW.representation_content_type IS DISTINCT FROM OLD.representation_content_type
    OR NEW.representation_byte_size IS DISTINCT FROM OLD.representation_byte_size
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'email delivery identity, representation and deadlines are immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
