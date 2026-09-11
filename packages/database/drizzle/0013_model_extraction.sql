CREATE TYPE "claim_kind" AS ENUM ('FACT', 'REQUIREMENT', 'ASSUMPTION', 'INFERENCE', 'QUESTION', 'CONTRADICTION', 'RISK');
CREATE TYPE "claim_sensitivity" AS ENUM ('PUBLIC', 'CONTACT', 'CONFIDENTIAL', 'SENSITIVE');
CREATE TYPE "claim_audience" AS ENUM ('INTERNAL', 'PROSPECT');
CREATE TYPE "claim_validity" AS ENUM ('CURRENT', 'REPLACED', 'DISCARDED', 'PENDING');
CREATE TYPE "claim_creator" AS ENUM ('HUMAN', 'RULE', 'MODEL');
CREATE TYPE "claim_source_relation" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CONTEXT');
CREATE TYPE "claim_relation_kind" AS ENUM ('REPLACES', 'CONTRADICTS', 'DEPENDS_ON', 'CLARIFIES', 'DERIVES_FROM');
CREATE TYPE "model_invocation_status" AS ENUM ('RESERVED', 'SUCCEEDED', 'INVALID', 'FAILED', 'UNCERTAIN', 'BUDGET_REJECTED');
CREATE TYPE "candidate_batch_status" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_organization_case_id_unique"
  UNIQUE ("organization_id", "case_id", "id");

CREATE TABLE "claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "kind" "claim_kind" NOT NULL,
  "category" text NOT NULL,
  "content" text NOT NULL,
  "confidence_basis_points" integer NOT NULL,
  "confirmed" boolean DEFAULT false NOT NULL,
  "sensitivity" "claim_sensitivity" NOT NULL,
  "audience" "claim_audience" NOT NULL,
  "validity" "claim_validity" DEFAULT 'CURRENT' NOT NULL,
  "creator" "claim_creator" NOT NULL,
  "model_invocation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claims_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "claims_membership_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "claims_values_check" CHECK (length("category") > 0 AND length("content") > 0 AND "confidence_basis_points" BETWEEN 0 AND 10000)
);
CREATE INDEX "claims_current_idx" ON "claims" ("organization_id", "case_id", "validity", "category");

CREATE TABLE "claim_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "relation" "claim_source_relation" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_sources_claim_fk" FOREIGN KEY ("organization_id", "case_id", "claim_id") REFERENCES "claims"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "claim_sources_message_fk" FOREIGN KEY ("organization_id", "case_id", "message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "claim_sources_unique" UNIQUE ("organization_id", "claim_id", "message_id", "relation")
);

CREATE TABLE "claim_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "source_claim_id" uuid NOT NULL,
  "target_claim_id" uuid NOT NULL,
  "relation" "claim_relation_kind" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_relations_source_fk" FOREIGN KEY ("organization_id", "case_id", "source_claim_id") REFERENCES "claims"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "claim_relations_target_fk" FOREIGN KEY ("organization_id", "case_id", "target_claim_id") REFERENCES "claims"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "claim_relations_unique" UNIQUE ("organization_id", "source_claim_id", "target_claim_id", "relation"),
  CONSTRAINT "claim_relations_distinct_check" CHECK ("source_claim_id" <> "target_claim_id")
);

CREATE TABLE "model_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "interview_id" uuid NOT NULL,
  "reservation_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "reasoning_effort" text NOT NULL,
  "prompt_id" text NOT NULL,
  "prompt_version" integer NOT NULL,
  "prompt_hash" text NOT NULL,
  "schema_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "schema_hash" text NOT NULL,
  "context_package" jsonb NOT NULL,
  "context_hash" text NOT NULL,
  "expected_interview_version" integer NOT NULL,
  "status" "model_invocation_status" DEFAULT 'RESERVED' NOT NULL,
  "provider_response_id" text,
  "structured_output" jsonb,
  "error_code" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_micros" bigint,
  "latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "model_invocations_interview_fk" FOREIGN KEY ("organization_id", "case_id", "interview_id") REFERENCES "interviews"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "model_invocations_reservation_fk" FOREIGN KEY ("organization_id", "case_id", "reservation_id") REFERENCES "budget_reservations"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "model_invocations_reservation_unique" UNIQUE ("organization_id", "reservation_id"),
  CONSTRAINT "model_invocations_membership_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "model_invocations_values_check" CHECK ("purpose" IN ('INTERVIEW_EXTRACT', 'NEXT_QUESTION') AND length("provider") > 0 AND length("model") > 0 AND "prompt_version" > 0 AND "schema_version" > 0 AND "expected_interview_version" > 0 AND length("prompt_hash") = 64 AND length("schema_hash") = 64 AND length("context_hash") = 64 AND ("input_tokens" IS NULL OR "input_tokens" >= 0) AND ("output_tokens" IS NULL OR "output_tokens" >= 0) AND ("cost_micros" IS NULL OR "cost_micros" >= 0) AND ("latency_ms" IS NULL OR "latency_ms" >= 0))
);
CREATE INDEX "model_invocations_case_idx" ON "model_invocations" ("organization_id", "case_id", "created_at");

ALTER TABLE "claims" ADD CONSTRAINT "claims_model_invocation_fk"
  FOREIGN KEY ("organization_id", "case_id", "model_invocation_id")
  REFERENCES "model_invocations"("organization_id", "case_id", "id") ON DELETE RESTRICT;
ALTER TABLE "claims" ADD CONSTRAINT "claims_creator_check"
  CHECK (("creator" = 'MODEL') = ("model_invocation_id" IS NOT NULL));
CREATE INDEX "claims_invocation_idx" ON "claims" ("organization_id", "model_invocation_id");

CREATE TABLE "model_invocation_messages" (
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "invocation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "position" integer NOT NULL,
  CONSTRAINT "model_invocation_messages_pk" PRIMARY KEY ("organization_id", "invocation_id", "message_id"),
  CONSTRAINT "model_invocation_messages_invocation_fk" FOREIGN KEY ("organization_id", "case_id", "invocation_id") REFERENCES "model_invocations"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "model_invocation_messages_message_fk" FOREIGN KEY ("organization_id", "case_id", "message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "model_invocation_messages_position_unique" UNIQUE ("organization_id", "invocation_id", "position"),
  CONSTRAINT "model_invocation_messages_position_check" CHECK ("position" >= 0)
);

CREATE TABLE "model_candidate_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "invocation_id" uuid NOT NULL,
  "output" jsonb NOT NULL,
  "status" "candidate_batch_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_candidate_batches_invocation_fk" FOREIGN KEY ("organization_id", "case_id", "invocation_id") REFERENCES "model_invocations"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "model_candidate_batches_invocation_unique" UNIQUE ("organization_id", "invocation_id")
);
