CREATE TYPE "budget_reservation_status" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED', 'UNCERTAIN', 'REJECTED');

CREATE TABLE "budget_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "alert_micros" bigint NOT NULL,
  "hard_limit_micros" bigint NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budget_policies_version_unique" UNIQUE ("organization_id", "version"),
  CONSTRAINT "budget_policies_organization_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "budget_policies_currency_check" CHECK ("currency" = 'USD'),
  CONSTRAINT "budget_policies_limits_check" CHECK ("version" > 0 AND "alert_micros" > 0 AND "hard_limit_micros" >= "alert_micros")
);
CREATE INDEX "budget_policies_effective_idx" ON "budget_policies" ("organization_id", "effective_at");

CREATE TABLE "budget_ledgers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "period_key" text DEFAULT 'R1_CASE_LIFETIME' NOT NULL,
  "reserved_micros" bigint DEFAULT 0 NOT NULL,
  "consumed_micros" bigint DEFAULT 0 NOT NULL,
  "uncertain_micros" bigint DEFAULT 0 NOT NULL,
  "alerted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budget_ledgers_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "budget_ledgers_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "budget_policies"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "budget_ledgers_unique" UNIQUE ("organization_id", "case_id", "period_key"),
  CONSTRAINT "budget_ledgers_organization_case_id_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "budget_ledgers_nonnegative" CHECK ("reserved_micros" >= 0 AND "consumed_micros" >= 0 AND "uncertain_micros" >= 0),
  CONSTRAINT "budget_ledgers_period_check" CHECK ("period_key" = 'R1_CASE_LIFETIME')
);

CREATE TABLE "budget_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "case_id" uuid NOT NULL,
  "ledger_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "purpose" text NOT NULL,
  "logical_operation_key" text NOT NULL,
  "attempt_key" text NOT NULL,
  "maximum_cost_micros" bigint NOT NULL,
  "actual_cost_micros" bigint,
  "status" "budget_reservation_status" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reconciled_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budget_reservations_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "budget_reservations_ledger_fk" FOREIGN KEY ("organization_id", "case_id", "ledger_id") REFERENCES "budget_ledgers"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "budget_reservations_attempt_unique" UNIQUE ("organization_id", "attempt_key"),
  CONSTRAINT "budget_reservations_values_check" CHECK ("maximum_cost_micros" > 0 AND ("actual_cost_micros" IS NULL OR "actual_cost_micros" >= 0)),
  CONSTRAINT "budget_reservations_stage_check" CHECK (length("stage") > 0),
  CONSTRAINT "budget_reservations_operation_check" CHECK (length("logical_operation_key") > 0),
  CONSTRAINT "budget_reservations_purpose_check" CHECK ("purpose" IN ('INTERVIEW_EXTRACT', 'NEXT_QUESTION', 'BRIEF_SYNTHESIS', 'BOUNDED_RESEARCH'))
);
CREATE INDEX "budget_reservations_operation_idx" ON "budget_reservations" ("organization_id", "case_id", "logical_operation_key");

CREATE FUNCTION reject_budget_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'budget policy is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER budget_policies_immutable BEFORE UPDATE OR DELETE ON "budget_policies"
FOR EACH ROW EXECUTE FUNCTION reject_budget_policy_mutation();
