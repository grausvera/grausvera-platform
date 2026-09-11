CREATE TYPE "next_action_kind" AS ENUM ('ASK', 'SUMMARIZE', 'PAUSE', 'ESCALATE', 'READY');
CREATE TYPE "next_action_proposal_status" AS ENUM ('PENDING', 'AUTHORIZED', 'REJECTED');

CREATE TABLE "next_action_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "interview_id" uuid NOT NULL,
  "model_invocation_id" uuid NOT NULL,
  "action" "next_action_kind" NOT NULL,
  "question" text,
  "summary" text,
  "reason_code" text NOT NULL,
  "target_topic" text,
  "referenced_claim_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" "next_action_proposal_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "next_action_proposals_interview_fk" FOREIGN KEY ("organization_id", "case_id", "interview_id") REFERENCES "interviews"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "next_action_proposals_invocation_fk" FOREIGN KEY ("organization_id", "case_id", "model_invocation_id") REFERENCES "model_invocations"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "next_action_proposals_invocation_unique" UNIQUE ("organization_id", "model_invocation_id"),
  CONSTRAINT "next_action_proposals_reason_check" CHECK (length("reason_code") BETWEEN 1 AND 80),
  CONSTRAINT "next_action_proposals_references_check" CHECK (jsonb_typeof("referenced_claim_ids") = 'array'),
  CONSTRAINT "next_action_proposals_shape_check" CHECK (
    ("action" = 'ASK' AND length("question") BETWEEN 1 AND 500 AND "summary" IS NULL AND length("target_topic") BETWEEN 1 AND 80)
    OR ("action" = 'SUMMARIZE' AND "question" IS NULL AND length("summary") BETWEEN 1 AND 500 AND "target_topic" IS NULL)
    OR ("action" IN ('PAUSE', 'ESCALATE', 'READY') AND "question" IS NULL AND "summary" IS NULL AND "target_topic" IS NULL)
  )
);
CREATE INDEX "next_action_proposals_pending_idx" ON "next_action_proposals" ("organization_id", "case_id", "status", "created_at");
