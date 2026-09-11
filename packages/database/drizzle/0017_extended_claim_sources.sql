CREATE TABLE "external_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "canonical_url" text NOT NULL,
  "title" text NOT NULL,
  "publisher" text NOT NULL,
  "accessed_at" timestamp with time zone NOT NULL,
  "excerpt" text NOT NULL,
  "content_hash" text,
  "source_version" text,
  "purpose" text NOT NULL,
  "confidence_basis_points" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_sources_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "external_sources_membership_unique" UNIQUE ("organization_id", "case_id", "id"),
  CONSTRAINT "external_sources_url_unique" UNIQUE ("organization_id", "case_id", "canonical_url", "content_hash", "source_version"),
  CONSTRAINT "external_sources_values_check" CHECK (
    length("canonical_url") > 0 AND length("title") > 0 AND length("publisher") > 0
    AND length("excerpt") > 0 AND length("purpose") > 0
    AND "confidence_basis_points" BETWEEN 0 AND 10000
    AND (("content_hash" IS NOT NULL AND length("content_hash") = 64) OR "source_version" IS NOT NULL)
  )
);
CREATE INDEX "external_sources_case_idx" ON "external_sources" ("organization_id", "case_id", "accessed_at");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_membership_unique"
  UNIQUE ("organization_id", "case_id", "id");

ALTER TABLE "claim_sources" ALTER COLUMN "message_id" DROP NOT NULL;
ALTER TABLE "claim_sources" ADD COLUMN "attachment_id" uuid;
ALTER TABLE "claim_sources" ADD COLUMN "external_source_id" uuid;
ALTER TABLE "claim_sources" DROP CONSTRAINT "claim_sources_unique";
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_attachment_fk"
  FOREIGN KEY ("organization_id", "case_id", "attachment_id")
  REFERENCES "attachments"("organization_id", "case_id", "id") ON DELETE RESTRICT;
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_external_fk"
  FOREIGN KEY ("organization_id", "case_id", "external_source_id")
  REFERENCES "external_sources"("organization_id", "case_id", "id") ON DELETE RESTRICT;
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_exactly_one_check"
  CHECK (num_nonnulls("message_id", "attachment_id", "external_source_id") = 1);
CREATE UNIQUE INDEX "claim_sources_message_unique" ON "claim_sources"
  ("organization_id", "claim_id", "message_id", "relation") WHERE "message_id" IS NOT NULL;
CREATE UNIQUE INDEX "claim_sources_attachment_unique" ON "claim_sources"
  ("organization_id", "claim_id", "attachment_id", "relation") WHERE "attachment_id" IS NOT NULL;
CREATE UNIQUE INDEX "claim_sources_external_unique" ON "claim_sources"
  ("organization_id", "claim_id", "external_source_id", "relation") WHERE "external_source_id" IS NOT NULL;
