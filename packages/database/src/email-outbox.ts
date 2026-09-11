import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface SealedEmailSecret {
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  authenticationTag: Uint8Array;
  keyReference: string;
}

export interface EmailSecretSealer {
  seal(value: { to: string; verificationUrl: string }): SealedEmailSecret;
}

export interface ClaimedVerificationEmail {
  id: string;
  organizationId: string;
  caseId: string;
  challengeId: string;
  contactPointId: string;
  secretReference: string;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  authenticationTag: Uint8Array;
  keyReference: string;
  idempotencyKey: string;
  attemptNumber: number;
  deadlineAt: Date;
}

export type EmailDeliveryResult =
  | { kind: "accepted"; externalId: string }
  | { kind: "rejected"; errorCode: string; retryable: boolean }
  | { kind: "uncertain"; errorCode: string };

export class EmailVerificationOutboxStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async request(input: {
    organizationId: string;
    caseId: string;
    contactPointId: string;
    destination: string;
    verificationBaseUrl: string;
    idempotencyKey: string;
    expiresAt: Date;
    sealer: EmailSecretSealer;
    explicitResend?: boolean;
  }): Promise<{ challengeId: string; outboxEventId: string; replayed: boolean }> {
    if (!/^\S+@\S+\.\S+$/.test(input.destination)) throw new Error("invalid_email_destination");
    if (input.expiresAt.getTime() <= Date.now()) throw new Error("invalid_challenge_expiry");
    const existing = await this.#existing(input.organizationId, input.idempotencyKey);
    if (existing) return { ...existing, replayed: true };

    const token = randomBytes(32).toString("base64url");
    const challengeId = randomUUID();
    const secretReference = randomUUID();
    const outboxEventId = randomUUID();
    const verificationUrl = `${input.verificationBaseUrl.replace(/\/$/, "")}/${challengeId}?token=${encodeURIComponent(token)}`;
    const sealed = input.sealer.seal({ to: input.destination, verificationUrl });
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM contact_points WHERE id=$1 FOR UPDATE`, [
        input.contactPointId,
      ]);
      const previous = await client
        .query<{ id: string }>(
          `SELECT id FROM email_verification_challenges
           WHERE organization_id=$1 AND case_id=$2 AND contact_point_id=$3
             AND purpose='BRIEF_DELIVERY' AND status='PENDING' FOR UPDATE`,
          [input.organizationId, input.caseId, input.contactPointId],
        )
        .then((result) => result.rows[0]);
      if (input.explicitResend) {
        const recent = await client
          .query<{ count: number }>(
            `SELECT count(*)::integer count FROM email_verification_challenges
             WHERE organization_id=$1 AND case_id=$2 AND contact_point_id=$3
               AND purpose='BRIEF_DELIVERY' AND created_at > now() - interval '1 hour'`,
            [input.organizationId, input.caseId, input.contactPointId],
          )
          .then((result) => result.rows[0]?.count ?? 0);
        if (!previous) throw new Error("verification_resend_unavailable");
        if (recent >= 3) throw new Error("verification_resend_limited");
      } else if (previous) {
        throw new Error("verification_already_pending");
      }
      if (previous) await this.#revoke(client, previous.id);
      await client.query(
        `INSERT INTO email_verification_challenges
          (id,organization_id,case_id,contact_point_id,purpose,token_digest,expires_at,
           previous_challenge_id)
         VALUES ($1,$2,$3,$4,'BRIEF_DELIVERY',$5,$6,$7)`,
        [
          challengeId,
          input.organizationId,
          input.caseId,
          input.contactPointId,
          createHash("sha256").update(token).digest("hex"),
          input.expiresAt,
          previous?.id ?? null,
        ],
      );
      await client.query(
        `INSERT INTO email_verification_outbox_secrets
          (id,challenge_id,ciphertext,initialization_vector,authentication_tag,key_reference,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          secretReference,
          challengeId,
          Buffer.from(sealed.ciphertext),
          Buffer.from(sealed.initializationVector),
          Buffer.from(sealed.authenticationTag),
          sealed.keyReference,
          input.expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,case_id,event_type,aggregate_type,aggregate_id,payload,
           idempotency_key,deadline_at)
         VALUES ($1,$2,$3,'email.transactional.send.v1','email_verification_challenge',$4,$5,$6,$7)`,
        [
          outboxEventId,
          input.organizationId,
          input.caseId,
          challengeId,
          JSON.stringify({
            purpose: "EMAIL_VERIFICATION",
            templateId: "email-verification",
            templateVersion: 1,
            challengeId,
            contactPointId: input.contactPointId,
            secretReference,
          }),
          input.idempotencyKey,
          input.expiresAt,
        ],
      );
      await client.query("COMMIT");
      return { challengeId, outboxEventId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const replay = await this.#existing(input.organizationId, input.idempotencyKey);
        if (replay) return { ...replay, replayed: true };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async changeContact(input: {
    organizationId: string;
    caseId: string;
    contactPointId: string;
    valueCiphertext: string;
    fingerprint: string;
  }): Promise<void> {
    if (!input.valueCiphertext || !input.fingerprint) throw new Error("invalid_contact_change");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const contact = await client.query(
        `SELECT cp.id FROM contact_points cp
         JOIN case_participants p ON p.organization_id=cp.organization_id
           AND p.person_id=cp.person_id AND p.case_id=$2
         WHERE cp.organization_id=$1 AND cp.id=$3 AND cp.kind='EMAIL' FOR UPDATE OF cp`,
        [input.organizationId, input.caseId, input.contactPointId],
      );
      if ((contact.rowCount ?? 0) !== 1) throw new Error("email_contact_unavailable");
      const challenges = await client.query<{ id: string }>(
        `SELECT c.id FROM email_verification_challenges c
         WHERE c.organization_id=$1 AND c.contact_point_id=$2 AND c.status='PENDING'
         FOR UPDATE OF c`,
        [input.organizationId, input.contactPointId],
      );
      for (const challenge of challenges.rows) await this.#revoke(client, challenge.id);
      const changed = await client.query(
        `UPDATE contact_points SET value_ciphertext=$2,fingerprint=$3,verified_at=NULL,
           version=version+1,updated_at=now()
         WHERE organization_id=$1 AND id=$4 AND kind='EMAIL'`,
        [input.organizationId, input.valueCiphertext, input.fingerprint, input.contactPointId],
      );
      if ((changed.rowCount ?? 0) !== 1) throw new Error("email_contact_unavailable");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(): Promise<ClaimedVerificationEmail | undefined> {
    await this.#expirePending();
    const result = await this.#pool.query<ClaimedVerificationEmail>(
      `WITH candidate AS (
         SELECT o.id FROM outbox_events o
         JOIN email_verification_outbox_secrets s ON s.id=(o.payload->>'secretReference')::uuid
         WHERE o.event_type='email.transactional.send.v1' AND o.status='PENDING'
           AND o.available_at<=now() AND o.deadline_at>now() AND s.destroyed_at IS NULL
         ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
       )
       UPDATE outbox_events o SET status='DISPATCHING',locked_at=now(),attempts=attempts+1,updated_at=now()
       FROM candidate,email_verification_outbox_secrets s
       WHERE o.id=candidate.id AND s.id=(o.payload->>'secretReference')::uuid
       RETURNING o.id,o.organization_id "organizationId",o.case_id "caseId",
         o.aggregate_id "challengeId",(o.payload->>'contactPointId')::uuid "contactPointId",
         s.id "secretReference",s.ciphertext,s.initialization_vector "initializationVector",
         s.authentication_tag "authenticationTag",s.key_reference "keyReference",
         o.idempotency_key "idempotencyKey",o.attempts "attemptNumber",o.deadline_at "deadlineAt"`,
    );
    return result.rows[0];
  }

  async authorizeDispatch(item: ClaimedVerificationEmail): Promise<boolean> {
    const result = await this.#pool.query(
      `SELECT 1 FROM email_verification_challenges c
       JOIN contact_points cp ON cp.organization_id=c.organization_id AND cp.id=c.contact_point_id
       WHERE c.id=$1 AND c.organization_id=$2 AND c.case_id=$3 AND c.contact_point_id=$4
         AND c.status='PENDING' AND c.expires_at>now() AND cp.verified_at IS NULL`,
      [item.challengeId, item.organizationId, item.caseId, item.contactPointId],
    );
    if ((result.rowCount ?? 0) === 1) return true;
    await this.#cancelAndDestroy(item.id, item.secretReference, "verification_not_authorized");
    return false;
  }

  async markAbandonedDispatchesUncertain(lockedBefore: Date): Promise<number> {
    const result = await this.#pool.query(
      `UPDATE outbox_events SET status='UNCERTAIN',last_error_code='worker_interrupted',
         locked_at=NULL,updated_at=now()
       WHERE event_type='email.transactional.send.v1' AND status='DISPATCHING' AND locked_at<$1`,
      [lockedBefore],
    );
    return result.rowCount ?? 0;
  }

  async finish(item: ClaimedVerificationEmail, result: EmailDeliveryResult): Promise<void> {
    const status =
      result.kind === "accepted"
        ? "ACCEPTED"
        : result.kind === "uncertain"
          ? "UNCERTAIN"
          : result.retryable
            ? "PENDING"
            : "NEEDS_ACTION";
    const destroy = result.kind === "accepted" || (result.kind === "rejected" && !result.retryable);
    const externalId = result.kind === "accepted" ? result.externalId : null;
    const errorCode = result.kind === "accepted" ? null : result.errorCode;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE outbox_events SET status=$2::outbox_status,provider_external_id=$3,last_error_code=$4,
           locked_at=NULL,updated_at=now(),available_at=CASE WHEN $2='PENDING' THEN now()+interval '30 seconds' ELSE available_at END
         WHERE id=$1 AND status='DISPATCHING'`,
        [item.id, status, externalId, errorCode],
      );
      if (destroy) await this.#destroy(client, item.secretReference);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #revoke(client: import("pg").PoolClient, challengeId: string) {
    await client.query(
      `UPDATE email_verification_challenges SET status='REVOKED',revoked_at=now(),updated_at=now()
       WHERE id=$1 AND status='PENDING'`,
      [challengeId],
    );
    await client.query(
      `UPDATE outbox_events SET status='CANCELLED',last_error_code='challenge_replaced',updated_at=now()
       WHERE aggregate_id=$1 AND event_type='email.transactional.send.v1' AND status IN ('PENDING','DISPATCHING')`,
      [challengeId],
    );
    await client.query(
      `UPDATE email_verification_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
         authentication_tag=NULL,destroyed_at=now() WHERE challenge_id=$1 AND destroyed_at IS NULL`,
      [challengeId],
    );
  }

  async #destroy(client: import("pg").PoolClient, secretReference: string) {
    await client.query(
      `UPDATE email_verification_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
         authentication_tag=NULL,destroyed_at=now() WHERE id=$1 AND destroyed_at IS NULL`,
      [secretReference],
    );
  }

  async #cancelAndDestroy(eventId: string, secretReference: string, errorCode: string) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE outbox_events SET status='CANCELLED',locked_at=NULL,last_error_code=$2,updated_at=now()
         WHERE id=$1 AND status='DISPATCHING'`,
        [eventId, errorCode],
      );
      await this.#destroy(client, secretReference);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #existing(organizationId: string, idempotencyKey: string) {
    return this.#pool
      .query<{ challengeId: string; outboxEventId: string }>(
        `SELECT aggregate_id "challengeId",id "outboxEventId" FROM outbox_events
         WHERE organization_id=$1 AND idempotency_key=$2
           AND event_type='email.transactional.send.v1'`,
        [organizationId, idempotencyKey],
      )
      .then((result) => result.rows[0]);
  }

  async #expirePending() {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{ id: string }>(
        `UPDATE email_verification_challenges SET status='EXPIRED',revoked_at=now(),updated_at=now()
         WHERE status='PENDING' AND expires_at<=now() RETURNING id`,
      );
      if (expired.rows.length > 0) {
        const ids = expired.rows.map((row) => row.id);
        await client.query(
          `UPDATE outbox_events SET status='NEEDS_ACTION',last_error_code='challenge_expired',updated_at=now()
           WHERE aggregate_id=ANY($1::uuid[]) AND event_type='email.transactional.send.v1'
             AND status IN ('PENDING','DISPATCHING')`,
          [ids],
        );
        await client.query(
          `UPDATE email_verification_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
             authentication_tag=NULL,destroyed_at=now()
           WHERE challenge_id=ANY($1::uuid[]) AND destroyed_at IS NULL`,
          [ids],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
