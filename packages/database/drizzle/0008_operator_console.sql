CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "twoFactorEnabled" boolean
);
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp with time zone,
  "refreshTokenExpiresAt" timestamp with time zone,
  "scope" text,
  "password" text,
  "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL
);
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "twoFactor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamp with time zone
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");

CREATE TABLE "operator_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'ENGINEER',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operator_memberships_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "operator_memberships_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
  CONSTRAINT "operator_memberships_unique" UNIQUE ("organization_id", "user_id"),
  CONSTRAINT "operator_memberships_role_check" CHECK ("role" = 'ENGINEER')
);
CREATE TABLE "operator_case_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operator_case_assignments_case_fk" FOREIGN KEY ("organization_id", "case_id") REFERENCES "prospect_cases"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "operator_case_assignments_membership_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "operator_memberships"("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "operator_case_assignments_unique" UNIQUE ("organization_id", "case_id")
);
CREATE INDEX "operator_memberships_user_idx" ON "operator_memberships" ("user_id", "active");
CREATE INDEX "operator_case_assignments_user_idx" ON "operator_case_assignments" ("organization_id", "user_id", "active");

ALTER TABLE "outbox_events" ADD COLUMN "authorized_operator_user_id" text;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_operator_membership_fk"
  FOREIGN KEY ("organization_id", "authorized_operator_user_id")
  REFERENCES "operator_memberships"("organization_id", "user_id") ON DELETE RESTRICT;
