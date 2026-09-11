ALTER TABLE "email_deliveries" ADD COLUMN "representation_object_key" text;
ALTER TABLE "email_deliveries" ADD COLUMN "representation_hash" text;
ALTER TABLE "email_deliveries" ADD COLUMN "representation_content_type" text;
ALTER TABLE "email_deliveries" ADD COLUMN "representation_byte_size" integer;
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_representation_check" CHECK (
  ("representation_object_key" IS NULL AND "representation_hash" IS NULL
    AND "representation_content_type" IS NULL AND "representation_byte_size" IS NULL)
  OR (length("representation_object_key") > 0 AND length("representation_hash")=64
    AND "representation_hash" ~ '^[0-9a-f]{64}$'
    AND "representation_content_type"='application/json' AND "representation_byte_size">0)
);

CREATE TABLE "email_delivery_outbox_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "email_deliveries" ("id") ON DELETE RESTRICT,
  "ciphertext" bytea,
  "initialization_vector" bytea,
  "authentication_tag" bytea,
  "key_reference" text NOT NULL,
  "destroyed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_delivery_outbox_secrets_delivery_unique" UNIQUE ("delivery_id"),
  CONSTRAINT "email_delivery_outbox_secrets_lifecycle_check" CHECK (
    (("destroyed_at" IS NULL AND "ciphertext" IS NOT NULL
      AND octet_length("initialization_vector")=12 AND octet_length("authentication_tag")=16)
    OR ("destroyed_at" IS NOT NULL AND "ciphertext" IS NULL
      AND "initialization_vector" IS NULL AND "authentication_tag" IS NULL))
    AND length("key_reference")>0
  )
);

CREATE FUNCTION protect_email_delivery_outbox_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.key_reference IS DISTINCT FROM OLD.key_reference
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.destroyed_at IS NOT NULL
    OR NEW.destroyed_at IS NULL OR NEW.ciphertext IS NOT NULL
    OR NEW.initialization_vector IS NOT NULL OR NEW.authentication_tag IS NOT NULL THEN
    RAISE EXCEPTION 'delivery secret is immutable or destruction is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_delivery_outbox_secrets_transition BEFORE UPDATE OR DELETE
  ON "email_delivery_outbox_secrets" FOR EACH ROW
  EXECUTE FUNCTION protect_email_delivery_outbox_secret();

CREATE OR REPLACE FUNCTION validate_email_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.representation_object_key IS NULL OR NEW.representation_hash IS NULL OR NOT EXISTS (
    SELECT 1 FROM brief_approvals a
    JOIN brief_revisions r ON r.organization_id=a.organization_id AND r.case_id=a.case_id
      AND r.brief_id=a.brief_id AND r.id=a.revision_id
    JOIN contact_points cp ON cp.organization_id=a.organization_id AND cp.id=NEW.contact_point_id
    JOIN case_participants p ON p.organization_id=cp.organization_id
      AND p.person_id=cp.person_id AND p.case_id=a.case_id
    JOIN outbox_events o ON o.id=NEW.outbox_event_id AND o.organization_id=a.organization_id
      AND o.case_id=a.case_id AND o.aggregate_id=NEW.id
    WHERE a.id=NEW.approval_id AND a.organization_id=NEW.organization_id
      AND a.case_id=NEW.case_id AND a.brief_id=NEW.brief_id AND a.revision_id=NEW.revision_id
      AND a.status='ACTIVE' AND a.delivery_purpose='BRIEF_DELIVERY'
      AND (a.expires_at IS NULL OR a.expires_at>now())
      AND r.status='APPROVED' AND r.is_candidate AND cp.kind='EMAIL'
      AND cp.verified_at IS NOT NULL AND cp.delivery_blocked_at IS NULL
      AND o.event_type='email.transactional.send.v1' AND o.payload->>'purpose'='BRIEF_DELIVERY'
      AND (o.payload->>'approvalId')::uuid=NEW.approval_id
      AND (o.payload->>'briefRevisionId')::uuid=NEW.revision_id
      AND (o.payload->>'contactPointId')::uuid=NEW.contact_point_id
      AND o.payload->>'representationReference'=NEW.representation_object_key
  ) THEN
    RAISE EXCEPTION 'delivery requires exact active approval, representation, revision, contact and outbox'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

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
