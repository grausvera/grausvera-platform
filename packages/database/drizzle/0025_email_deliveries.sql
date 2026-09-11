CREATE TYPE "email_delivery_status" AS ENUM
  ('PENDING','ACCEPTED','DELIVERED','DELAYED','BOUNCED','FAILED','COMPLAINED',
   'UNCERTAIN','NEEDS_ACTION','CANCELLED');
CREATE TYPE "email_webhook_status" AS ENUM ('RECEIVED','PROCESSED','UNMATCHED','IGNORED');

ALTER TABLE "contact_points" ADD COLUMN "delivery_blocked_at" timestamp with time zone;
ALTER TABLE "contact_points" ADD COLUMN "delivery_block_reason" text;
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_delivery_block_check" CHECK (
  ("delivery_blocked_at" IS NULL AND "delivery_block_reason" IS NULL)
  OR ("delivery_blocked_at" IS NOT NULL AND length("delivery_block_reason") > 0)
);

CREATE TABLE "email_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "approval_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "purpose" text DEFAULT 'BRIEF_DELIVERY' NOT NULL,
  "status" "email_delivery_status" DEFAULT 'PENDING' NOT NULL,
  "provider_external_id" text,
  "first_attempt_at" timestamp with time zone,
  "deduplication_expires_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "last_provider_occurred_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_deliveries_approval_fk" FOREIGN KEY
    ("organization_id","case_id","brief_id","revision_id","approval_id")
    REFERENCES "brief_approvals"
    ("organization_id","case_id","brief_id","revision_id","id") ON DELETE RESTRICT,
  CONSTRAINT "email_deliveries_contact_fk" FOREIGN KEY ("organization_id","contact_point_id")
    REFERENCES "contact_points" ("organization_id","id") ON DELETE RESTRICT,
  CONSTRAINT "email_deliveries_outbox_fk" FOREIGN KEY ("outbox_event_id")
    REFERENCES "outbox_events" ("id") ON DELETE RESTRICT,
  CONSTRAINT "email_deliveries_membership_unique" UNIQUE ("organization_id","case_id","id"),
  CONSTRAINT "email_deliveries_outbox_unique" UNIQUE ("outbox_event_id"),
  CONSTRAINT "email_deliveries_values_check" CHECK (
    "purpose"='BRIEF_DELIVERY' AND "deadline_at" <= "deduplication_expires_at"
    AND "deduplication_expires_at" > "created_at"
    AND ("first_attempt_at" IS NULL OR "first_attempt_at" >= "created_at")
  )
);
CREATE UNIQUE INDEX "email_deliveries_provider_external_unique"
  ON "email_deliveries" ("provider_external_id") WHERE "provider_external_id" IS NOT NULL;
CREATE INDEX "email_deliveries_reconciliation_idx"
  ON "email_deliveries" ("status","deduplication_expires_at","updated_at");

CREATE TABLE "email_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "email_deliveries" ("id") ON DELETE RESTRICT,
  "attempt_number" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "outcome" "delivery_attempt_outcome",
  "provider_external_id" text,
  "error_code" text,
  CONSTRAINT "email_delivery_attempts_number_unique" UNIQUE ("delivery_id","attempt_number"),
  CONSTRAINT "email_delivery_attempts_values_check" CHECK (
    "attempt_number" > 0 AND length("idempotency_key") > 0
    AND (("completed_at" IS NULL AND "outcome" IS NULL)
      OR ("completed_at" IS NOT NULL AND "outcome" IS NOT NULL))
  )
);

CREATE TABLE "email_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_email_id" text,
  "provider_occurred_at" timestamp with time zone NOT NULL,
  "payload_bytes" bytea NOT NULL,
  "payload_hash" text NOT NULL,
  "status" "email_webhook_status" DEFAULT 'RECEIVED' NOT NULL,
  "delivery_id" uuid REFERENCES "email_deliveries" ("id") ON DELETE RESTRICT,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "email_webhook_events_external_unique" UNIQUE ("external_event_id"),
  CONSTRAINT "email_webhook_events_values_check" CHECK (
    length("event_type") > 0 AND length("payload_hash")=64
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND (("status" IN ('RECEIVED','UNMATCHED') AND "processed_at" IS NULL)
      OR ("status" IN ('PROCESSED','IGNORED') AND "processed_at" IS NOT NULL))
  )
);
CREATE INDEX "email_webhook_events_pending_idx"
  ON "email_webhook_events" ("status","received_at");

CREATE TABLE "email_delivery_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "email_deliveries" ("id") ON DELETE RESTRICT,
  "webhook_event_id" uuid NOT NULL REFERENCES "email_webhook_events" ("id") ON DELETE RESTRICT,
  "status" "email_delivery_status" NOT NULL,
  "provider_occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_delivery_observations_webhook_unique" UNIQUE ("webhook_event_id")
);

CREATE FUNCTION validate_email_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
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
      AND r.status='APPROVED' AND r.is_candidate AND cp.kind='EMAIL' AND cp.verified_at IS NOT NULL
      AND o.event_type='email.transactional.send.v1'
      AND o.payload->>'purpose'='BRIEF_DELIVERY'
      AND (o.payload->>'approvalId')::uuid=NEW.approval_id
      AND (o.payload->>'briefRevisionId')::uuid=NEW.revision_id
      AND (o.payload->>'contactPointId')::uuid=NEW.contact_point_id
  ) THEN
    RAISE EXCEPTION 'delivery requires exact active approval, revision, contact and outbox'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_deliveries_exact_authority BEFORE INSERT ON "email_deliveries"
  FOR EACH ROW EXECUTE FUNCTION validate_email_delivery();

CREATE FUNCTION protect_email_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'email delivery identity and deadlines are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_deliveries_identity BEFORE UPDATE OR DELETE ON "email_deliveries"
  FOR EACH ROW EXECUTE FUNCTION protect_email_delivery_identity();
