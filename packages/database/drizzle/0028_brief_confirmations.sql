CREATE TYPE "confirmer_designation_status" AS ENUM ('ACTIVE','REVOKED');
CREATE TYPE "confirmation_request_status" AS ENUM ('PENDING','CONSUMED','REVOKED','EXPIRED');

CREATE TABLE "case_confirmer_designations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL REFERENCES "case_participants"("id") ON DELETE RESTRICT,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "designated_by_user_id" text NOT NULL,
  "reason" text NOT NULL,
  "status" "confirmer_designation_status" DEFAULT 'ACTIVE' NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "case_confirmer_designations_case_fk" FOREIGN KEY ("organization_id","case_id")
    REFERENCES "prospect_cases"("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "case_confirmer_designations_contact_fk" FOREIGN KEY
    ("organization_id","person_id","contact_point_id") REFERENCES "contact_points"
    ("organization_id","person_id","id") ON DELETE RESTRICT,
  CONSTRAINT "case_confirmer_designations_operator_fk" FOREIGN KEY
    ("organization_id","designated_by_user_id") REFERENCES "operator_memberships"
    ("organization_id","user_id") ON DELETE RESTRICT,
  CONSTRAINT "case_confirmer_designations_values_check" CHECK (
    length(btrim("reason"))>0 AND (("status"='ACTIVE' AND "revoked_at" IS NULL)
      OR ("status"='REVOKED' AND "revoked_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "case_confirmer_designations_active_unique"
  ON "case_confirmer_designations"("organization_id","case_id") WHERE "status"='ACTIVE';

CREATE TABLE "confirmation_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "designation_id" uuid NOT NULL REFERENCES "case_confirmer_designations"("id") ON DELETE RESTRICT,
  "participant_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "approval_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "email_deliveries"("id") ON DELETE RESTRICT,
  "request_message_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "purpose" text DEFAULT 'NEED_AND_CONTINUE' NOT NULL,
  "template_id" text DEFAULT 'brief-confirmation' NOT NULL,
  "template_version" integer DEFAULT 1 NOT NULL,
  "status" "confirmation_request_status" DEFAULT 'PENDING' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "confirmation_requests_outbox_unique" UNIQUE("outbox_event_id"),
  CONSTRAINT "confirmation_requests_message_unique" UNIQUE("request_message_id"),
  CONSTRAINT "confirmation_requests_values_check" CHECK (
    "purpose"='NEED_AND_CONTINUE' AND "template_id"='brief-confirmation'
    AND "template_version"=1 AND "expires_at">"created_at"
    AND (("status"='PENDING' AND "consumed_at" IS NULL AND "revoked_at" IS NULL)
      OR ("status"='CONSUMED' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR ("status" IN ('REVOKED','EXPIRED') AND "consumed_at" IS NULL
        AND "revoked_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "confirmation_requests_pending_unique"
  ON "confirmation_requests"("organization_id","case_id") WHERE "status"='PENDING';

CREATE TABLE "confirmations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "confirmation_requests"("id") ON DELETE RESTRICT,
  "participant_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "email_deliveries"("id") ON DELETE RESTRICT,
  "source_message_id" uuid NOT NULL,
  "purpose" text DEFAULT 'NEED_AND_CONTINUE' NOT NULL,
  "normalized_action" text DEFAULT 'CONFIRMO' NOT NULL,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "confirmations_request_unique" UNIQUE("request_id"),
  CONSTRAINT "confirmations_source_message_unique" UNIQUE("source_message_id"),
  CONSTRAINT "confirmations_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
  CONSTRAINT "confirmations_values_check" CHECK (
    "purpose"='NEED_AND_CONTINUE' AND "normalized_action"='CONFIRMO'
  )
);

CREATE FUNCTION validate_confirmer_designation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM case_participants p JOIN contact_points cp
      ON cp.organization_id=p.organization_id AND cp.person_id=p.person_id
    WHERE p.id=NEW.participant_id AND p.organization_id=NEW.organization_id
      AND p.case_id=NEW.case_id AND p.person_id=NEW.person_id
      AND p.role IN ('REQUESTER','DECISION_MAKER') AND cp.id=NEW.contact_point_id
      AND cp.kind='WHATSAPP'
  ) THEN RAISE EXCEPTION 'confirmer must be an eligible case participant and WhatsApp contact'
    USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_confirmer_designations_exact BEFORE INSERT ON "case_confirmer_designations"
  FOR EACH ROW EXECUTE FUNCTION validate_confirmer_designation();

CREATE FUNCTION protect_confirmation_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'confirmation evidence cannot be deleted' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmations_append_only BEFORE UPDATE OR DELETE ON "confirmations"
  FOR EACH ROW EXECUTE FUNCTION protect_confirmation_records();

CREATE FUNCTION protect_confirmation_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'PENDING'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.designation_id IS DISTINCT FROM OLD.designation_id
    OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
    OR NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.contact_point_id IS DISTINCT FROM OLD.contact_point_id
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.request_message_id IS DISTINCT FROM OLD.request_message_id
    OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status NOT IN ('CONSUMED','REVOKED','EXPIRED') THEN
    RAISE EXCEPTION 'confirmation request is immutable or transition invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmation_requests_transition BEFORE UPDATE OR DELETE ON "confirmation_requests"
  FOR EACH ROW EXECUTE FUNCTION protect_confirmation_request();
