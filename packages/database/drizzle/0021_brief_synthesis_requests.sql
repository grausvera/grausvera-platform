CREATE TYPE "brief_synthesis_status" AS ENUM (
  'READY', 'RUNNING', 'SUCCEEDED', 'INVALID', 'FAILED', 'UNCERTAIN', 'BUDGET_REJECTED', 'EXHAUSTED'
);

ALTER TABLE "model_invocations" DROP CONSTRAINT "model_invocations_values_check";
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_values_check" CHECK (
  "purpose" IN ('INTERVIEW_EXTRACT', 'NEXT_QUESTION', 'BOUNDED_RESEARCH', 'BRIEF_SYNTHESIS')
  AND length("provider") > 0 AND length("model") > 0
  AND "prompt_version" > 0 AND "schema_version" > 0 AND "expected_interview_version" > 0
  AND length("prompt_hash") = 64 AND length("schema_hash") = 64 AND length("context_hash") = 64
  AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
  AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
  AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  AND (("purpose" IN ('BOUNDED_RESEARCH', 'BRIEF_SYNTHESIS') AND "interview_id" IS NULL)
    OR ("purpose" IN ('INTERVIEW_EXTRACT', 'NEXT_QUESTION') AND "interview_id" IS NOT NULL))
);

CREATE TABLE "brief_synthesis_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "knowledge_version" integer NOT NULL,
  "status" "brief_synthesis_status" DEFAULT 'READY' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "current_attempt_key" text,
  "reservation_id" uuid,
  "model_invocation_id" uuid,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brief_synthesis_requests_brief_fk" FOREIGN KEY
    ("organization_id", "case_id", "brief_id")
    REFERENCES "briefs" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_synthesis_requests_reservation_fk" FOREIGN KEY
    ("organization_id", "case_id", "reservation_id")
    REFERENCES "budget_reservations" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_synthesis_requests_invocation_fk" FOREIGN KEY
    ("organization_id", "case_id", "model_invocation_id")
    REFERENCES "model_invocations" ("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "brief_synthesis_requests_logical_unique" UNIQUE
    ("organization_id", "case_id", "knowledge_version"),
  CONSTRAINT "brief_synthesis_requests_attempt_unique" UNIQUE
    ("organization_id", "current_attempt_key"),
  CONSTRAINT "brief_synthesis_requests_values_check" CHECK (
    "knowledge_version" > 0 AND "attempt_count" BETWEEN 0 AND 2
    AND (("attempt_count" = 0 AND "current_attempt_key" IS NULL)
      OR ("attempt_count" > 0 AND length("current_attempt_key") > 0))
  )
);
