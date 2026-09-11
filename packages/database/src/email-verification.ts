import { createHash, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export const BRIEF_DELIVERY_PURPOSE = "BRIEF_DELIVERY" as const;
export type EmailVerificationPurpose = typeof BRIEF_DELIVERY_PURPOSE;

export interface EmailVerificationScope {
  organizationId: string;
  caseId: string;
  contactPointId: string;
  purpose: EmailVerificationPurpose;
}

interface ChallengeRow {
  id: string;
  organization_id: string;
  case_id: string;
  contact_point_id: string;
  purpose: string;
  token_digest: string;
  status: string;
  attempt_count: number;
  expires_at: Date;
}

export class EmailVerificationStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async verifyChallenge(input: {
    challengeId: string;
    token: string;
  }): Promise<{ verified: boolean }> {
    if (!isUuid(input.challengeId) || input.token.length < 1 || input.token.length > 512) {
      return { verified: false };
    }
    const scope = await this.#pool
      .query<{
        organization_id: string;
        case_id: string;
        contact_point_id: string;
        purpose: EmailVerificationPurpose;
      }>(
        `SELECT organization_id,case_id,contact_point_id,purpose
         FROM email_verification_challenges WHERE id=$1`,
        [input.challengeId],
      )
      .then((result) => result.rows[0]);
    if (!scope) return { verified: false };
    return this.consumeChallenge({
      challengeId: input.challengeId,
      organizationId: scope.organization_id,
      caseId: scope.case_id,
      contactPointId: scope.contact_point_id,
      purpose: scope.purpose,
      tokenDigest: createTokenDigest(input.token),
    });
  }

  async createChallenge(
    input: EmailVerificationScope & {
      tokenDigest: string;
      expiresAt: Date;
      maxAttempts?: number;
    },
  ): Promise<{ id: string; previousChallengeId: string | null }> {
    if (!/^[0-9a-f]{64}$/.test(input.tokenDigest)) throw new Error("invalid_token_digest");
    if (input.expiresAt.getTime() <= Date.now()) throw new Error("invalid_challenge_expiry");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const previous = await client
        .query<{ id: string }>(
          `SELECT id FROM email_verification_challenges
           WHERE organization_id=$1 AND case_id=$2 AND contact_point_id=$3
             AND purpose=$4 AND status='PENDING' FOR UPDATE`,
          [input.organizationId, input.caseId, input.contactPointId, input.purpose],
        )
        .then((result) => result.rows[0]);
      if (previous) {
        await client.query(
          `UPDATE email_verification_challenges SET status='REVOKED',revoked_at=now(),updated_at=now()
           WHERE id=$1`,
          [previous.id],
        );
      }
      const challenge = await client
        .query<{ id: string }>(
          `INSERT INTO email_verification_challenges
            (organization_id,case_id,contact_point_id,purpose,token_digest,expires_at,
             max_attempts,previous_challenge_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            input.organizationId,
            input.caseId,
            input.contactPointId,
            input.purpose,
            input.tokenDigest,
            input.expiresAt,
            input.maxAttempts ?? 5,
            previous?.id ?? null,
          ],
        )
        .then((result) => result.rows[0]);
      await client.query("COMMIT");
      if (!challenge) throw new Error("challenge_not_created");
      return { id: challenge.id, previousChallengeId: previous?.id ?? null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeChallenge(
    input: EmailVerificationScope & { challengeId: string; tokenDigest: string },
    now = new Date(),
  ): Promise<{ verified: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const challenge = await this.#lockChallenge(client, input.challengeId);
      if (!challenge || !this.#sameScope(challenge, input) || challenge.status !== "PENDING") {
        await client.query("COMMIT");
        return { verified: false };
      }
      if (challenge.expires_at.getTime() <= now.getTime()) {
        await client.query(
          `UPDATE email_verification_challenges SET status='EXPIRED',revoked_at=$2,updated_at=$2
           WHERE id=$1`,
          [challenge.id, now],
        );
        await client.query("COMMIT");
        return { verified: false };
      }
      if (!safeDigestEqual(challenge.token_digest, input.tokenDigest)) {
        const attempts = challenge.attempt_count + 1;
        await client.query(
          `UPDATE email_verification_challenges SET attempt_count=$2,
             status=CASE WHEN $2 >= max_attempts THEN 'REVOKED'::email_verification_challenge_status
               ELSE status END,
             revoked_at=CASE WHEN $2 >= max_attempts THEN $3 ELSE revoked_at END,updated_at=$3
           WHERE id=$1`,
          [challenge.id, attempts, now],
        );
        await client.query("COMMIT");
        return { verified: false };
      }
      await client.query(
        `UPDATE email_verification_challenges
         SET status='CONSUMED',consumed_at=$2,updated_at=$2 WHERE id=$1 AND status='PENDING'`,
        [challenge.id, now],
      );
      await client.query(
        `UPDATE contact_points SET verified_at=COALESCE(verified_at,$3),version=version+1,updated_at=$3
         WHERE organization_id=$1 AND id=$2 AND kind='EMAIL'`,
        [input.organizationId, input.contactPointId, now],
      );
      await client.query("COMMIT");
      return { verified: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockChallenge(client: PoolClient, id: string) {
    return client
      .query<ChallengeRow>(`SELECT * FROM email_verification_challenges WHERE id=$1 FOR UPDATE`, [
        id,
      ])
      .then((result) => result.rows[0]);
  }

  #sameScope(challenge: ChallengeRow, scope: EmailVerificationScope) {
    return (
      challenge.organization_id === scope.organizationId &&
      challenge.case_id === scope.caseId &&
      challenge.contact_point_id === scope.contactPointId &&
      challenge.purpose === scope.purpose
    );
  }
}

function safeDigestEqual(expected: string, supplied: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

function createTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
