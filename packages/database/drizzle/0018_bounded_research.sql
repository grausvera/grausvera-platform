CREATE TYPE "research_request_status" AS ENUM (
  'AUTHORIZED', 'BUDGET_REJECTED', 'RUNNING', 'SUCCEEDED', 'INVALID', 'FAILED', 'UNCERTAIN'
);

ALTER TABLE "prospect_cases" ADD COLUMN "knowledge_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "prospect_cases" ADD CONSTRAINT "prospect_cases_knowledge_version_positive"
  CHECK ("knowledge_version" > 0);

CREATE TABLE "research_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "question" text NOT NULL,
  "authorized_by_user_id" text NOT NULL,
  "knowledge_version" integer NOT NULL,
  "max_queries" integer DEFAULT 2 NOT NULL,
  "max_reads" integer DEFAULT 5 NOT NULL,
  "max_duration_seconds" integer DEFAULT 120 NOT NULL,
  "status" "research_request_status" DEFAULT 'AUTHORIZED' NOT NULL,
  "reservation_id" uuid,
  "model_invocation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "research_requests_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "research_requests_operator_fk" FOREIGN KEY ("organization_id", "authorized_by_user_id") REFERENCES "operator_memberships"("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "research_requests_reservation_fk" FOREIGN KEY ("organization_id", "case_id", "reservation_id") REFERENCES "budget_reservations"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "research_requests_membership_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "research_requests_values_check" CHECK (
    length("question") > 0 AND "knowledge_version" > 0
    AND "max_queries" BETWEEN 1 AND 2 AND "max_reads" BETWEEN 1 AND 5
    AND "max_duration_seconds" BETWEEN 1 AND 120
  )
);
CREATE INDEX "research_requests_case_idx" ON "research_requests" ("organization_id", "case_id", "created_at");

ALTER TABLE "model_invocations" ALTER COLUMN "interview_id" DROP NOT NULL;
ALTER TABLE "model_invocations" DROP CONSTRAINT "model_invocations_values_check";
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_values_check" CHECK (
  "purpose" IN ('INTERVIEW_EXTRACT', 'NEXT_QUESTION', 'BOUNDED_RESEARCH')
  AND length("provider") > 0 AND length("model") > 0
  AND "prompt_version" > 0 AND "schema_version" > 0 AND "expected_interview_version" > 0
  AND length("prompt_hash") = 64 AND length("schema_hash") = 64 AND length("context_hash") = 64
  AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
  AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
  AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  AND (("purpose" = 'BOUNDED_RESEARCH' AND "interview_id" IS NULL)
    OR ("purpose" <> 'BOUNDED_RESEARCH' AND "interview_id" IS NOT NULL))
);

ALTER TABLE "research_requests" ADD CONSTRAINT "research_requests_invocation_fk"
  FOREIGN KEY ("organization_id", "case_id", "model_invocation_id")
  REFERENCES "model_invocations"("organization_id", "case_id", "id") ON DELETE RESTRICT;
ALTER TABLE "external_sources" ADD COLUMN "research_request_id" uuid;
ALTER TABLE "external_sources" ADD CONSTRAINT "external_sources_research_request_fk"
  FOREIGN KEY ("organization_id", "case_id", "research_request_id")
  REFERENCES "research_requests"("organization_id", "case_id", "id") ON DELETE RESTRICT;
