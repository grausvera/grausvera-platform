CREATE TABLE "email_verification_outbox_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "challenge_id" uuid NOT NULL,
  "ciphertext" bytea,
  "initialization_vector" bytea,
  "authentication_tag" bytea,
  "key_reference" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "destroyed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_verification_outbox_secrets_challenge_fk" FOREIGN KEY ("challenge_id")
    REFERENCES "email_verification_challenges" ("id") ON DELETE RESTRICT,
  CONSTRAINT "email_verification_outbox_secrets_challenge_unique" UNIQUE ("challenge_id"),
  CONSTRAINT "email_verification_outbox_secrets_lifecycle_check" CHECK (
    (("destroyed_at" IS NULL AND "ciphertext" IS NOT NULL
      AND octet_length("initialization_vector") = 12 AND octet_length("authentication_tag") = 16)
    OR ("destroyed_at" IS NOT NULL AND "ciphertext" IS NULL
      AND "initialization_vector" IS NULL AND "authentication_tag" IS NULL))
    AND length("key_reference") > 0 AND "expires_at" > "created_at"
  )
);

CREATE FUNCTION protect_email_verification_outbox_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."challenge_id" IS DISTINCT FROM OLD."challenge_id"
    OR NEW."key_reference" IS DISTINCT FROM OLD."key_reference"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."destroyed_at" IS NOT NULL
    OR NEW."destroyed_at" IS NULL
    OR NEW."ciphertext" IS NOT NULL
    OR NEW."initialization_vector" IS NOT NULL
    OR NEW."authentication_tag" IS NOT NULL
  THEN
    RAISE EXCEPTION 'transient email secret is immutable or destruction is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_verification_outbox_secrets_transition BEFORE UPDATE OR DELETE
  ON "email_verification_outbox_secrets" FOR EACH ROW
  EXECUTE FUNCTION protect_email_verification_outbox_secret();
