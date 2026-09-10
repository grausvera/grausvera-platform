CREATE TYPE "conversation_intervention_kind" AS ENUM ('STOP', 'HUMAN_REQUEST');

CREATE TABLE "conversation_interventions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "contact_point_id" uuid NOT NULL,
  "source_message_id" uuid NOT NULL,
  "kind" "conversation_intervention_kind" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_interventions_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "conversation_interventions_source_fk" FOREIGN KEY ("organization_id", "case_id", "source_message_id") REFERENCES "messages"("organization_id", "case_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "conversation_interventions_contact_fk" FOREIGN KEY ("organization_id", "person_id", "contact_point_id") REFERENCES "contact_points"("organization_id", "person_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "conversation_interventions_source_unique" UNIQUE ("organization_id", "source_message_id")
);

CREATE INDEX "conversation_interventions_case_idx" ON "conversation_interventions" ("organization_id", "case_id", "created_at");
