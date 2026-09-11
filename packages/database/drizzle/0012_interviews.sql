CREATE TYPE "interview_status" AS ENUM ('NOT_STARTED', 'ACTIVE', 'SUFFICIENT');
CREATE TYPE "interview_topic_status" AS ENUM ('MISSING', 'CAPTURED', 'NOT_APPLICABLE');

CREATE TABLE "interview_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "locale" text DEFAULT 'es-PE' NOT NULL,
  "topics" jsonb NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interview_policies_version_unique" UNIQUE ("organization_id", "version"),
  CONSTRAINT "interview_policies_organization_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "interview_policies_values_check" CHECK ("version" > 0 AND length("locale") > 0 AND jsonb_typeof("topics") = 'array' AND jsonb_array_length("topics") > 0)
);
CREATE INDEX "interview_policies_effective_idx" ON "interview_policies" ("organization_id", "effective_at");

CREATE TABLE "interviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "status" "interview_status" DEFAULT 'NOT_STARTED' NOT NULL,
  "pending_question" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interviews_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "interviews_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "interview_policies"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "interviews_case_unique" UNIQUE ("organization_id", "case_id"),
  CONSTRAINT "interviews_organization_case_id_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "interviews_values_check" CHECK ("version" > 0 AND ("pending_question" IS NULL OR length("pending_question") > 0))
);

CREATE TABLE "interview_topics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "interview_id" uuid NOT NULL,
  "topic_key" text NOT NULL,
  "position" integer NOT NULL,
  "required" boolean NOT NULL,
  "status" "interview_topic_status" DEFAULT 'MISSING' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interview_topics_interview_fk" FOREIGN KEY ("organization_id", "case_id", "interview_id") REFERENCES "interviews"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "interview_topics_key_unique" UNIQUE ("organization_id", "interview_id", "topic_key"),
  CONSTRAINT "interview_topics_position_unique" UNIQUE ("organization_id", "interview_id", "position"),
  CONSTRAINT "interview_topics_values_check" CHECK (length("topic_key") > 0 AND "position" >= 0)
);

CREATE FUNCTION reject_interview_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'interview policy is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER interview_policies_immutable BEFORE UPDATE OR DELETE ON "interview_policies"
FOR EACH ROW EXECUTE FUNCTION reject_interview_policy_mutation();
