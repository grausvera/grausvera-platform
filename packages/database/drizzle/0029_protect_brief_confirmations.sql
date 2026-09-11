CREATE FUNCTION protect_confirmer_designation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'ACTIVE' OR NEW.status<>'REVOKED'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
    OR NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.contact_point_id IS DISTINCT FROM OLD.contact_point_id
    OR NEW.designated_by_user_id IS DISTINCT FROM OLD.designated_by_user_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'confirmer designation is immutable or transition invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_confirmer_designations_transition BEFORE UPDATE OR DELETE
  ON "case_confirmer_designations" FOR EACH ROW EXECUTE FUNCTION protect_confirmer_designation();

CREATE FUNCTION validate_confirmation_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM case_confirmer_designations d
    JOIN email_deliveries e ON e.organization_id=d.organization_id AND e.case_id=d.case_id
      AND e.id=NEW.delivery_id AND e.status='DELIVERED'
    JOIN brief_approvals a ON a.organization_id=e.organization_id AND a.id=e.approval_id
      AND a.id=NEW.approval_id AND a.status='ACTIVE'
    JOIN brief_revisions r ON r.organization_id=e.organization_id AND r.id=e.revision_id
      AND r.id=NEW.revision_id AND r.status='APPROVED' AND r.is_candidate
      AND r.snapshot_hash=a.snapshot_hash
    JOIN messages m ON m.organization_id=d.organization_id AND m.case_id=d.case_id
      AND m.id=NEW.request_message_id AND m.direction='OUTBOUND'
    JOIN outbox_events o ON o.id=NEW.outbox_event_id AND o.organization_id=d.organization_id
      AND o.case_id=d.case_id AND o.aggregate_id=NEW.id
      AND o.event_type='whatsapp.confirmation.request.v1'
    WHERE d.id=NEW.designation_id AND d.organization_id=NEW.organization_id
      AND d.case_id=NEW.case_id AND d.status='ACTIVE'
      AND d.participant_id=NEW.participant_id AND d.person_id=NEW.person_id
      AND d.contact_point_id=NEW.contact_point_id
  ) THEN RAISE EXCEPTION 'confirmation request does not match exact authority and delivery'
    USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmation_requests_exact BEFORE INSERT ON "confirmation_requests"
  FOR EACH ROW EXECUTE FUNCTION validate_confirmation_request();

CREATE FUNCTION validate_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM confirmation_requests q
    JOIN case_confirmer_designations d ON d.id=q.designation_id AND d.status='ACTIVE'
    JOIN email_deliveries e ON e.id=q.delivery_id AND e.status='DELIVERED'
    JOIN messages m ON m.organization_id=q.organization_id AND m.case_id=q.case_id
      AND m.id=NEW.source_message_id AND m.direction='INBOUND' AND m.message_type='text'
      AND m.sender_person_id=q.person_id AND m.sender_contact_point_id=q.contact_point_id
    JOIN outbox_events o ON o.id=q.outbox_event_id AND o.provider_external_id IS NOT NULL
      AND m.reply_to_provider_message_id=o.provider_external_id
    WHERE q.id=NEW.request_id AND q.organization_id=NEW.organization_id
      AND q.case_id=NEW.case_id AND q.status='PENDING' AND q.expires_at>NEW.occurred_at
      AND q.participant_id=NEW.participant_id AND q.person_id=NEW.person_id
      AND q.contact_point_id=NEW.contact_point_id AND q.revision_id=NEW.revision_id
      AND q.delivery_id=NEW.delivery_id
      AND upper(regexp_replace(btrim(convert_from(m.content_bytes,'UTF8')),'\s+',' ','g'))='CONFIRMO'
  ) THEN RAISE EXCEPTION 'confirmation does not match exact request and response'
    USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmations_exact BEFORE INSERT ON "confirmations"
  FOR EACH ROW EXECUTE FUNCTION validate_confirmation();
