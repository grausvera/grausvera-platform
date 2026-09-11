import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AesGcmEmailSecretCodec,
  EmailOutboxDispatcher,
  FakeEmailPort,
} from "../../apps/worker/src/email";
import {
  BRIEF_DELIVERY_PURPOSE,
  EmailVerificationOutboxStore,
  EmailVerificationStore,
} from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const store = new EmailVerificationStore(connectionString);
const outbox = new EmailVerificationOutboxStore(connectionString);
let organizationId: string;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id,slug,display_name) VALUES ($1,'grausvera','grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
});

afterAll(async () => {
  await store.close();
  await outbox.close();
  await pool.end();
});

async function scope() {
  const personId = randomUUID();
  const caseId = randomUUID();
  await pool.query(`INSERT INTO people (id,organization_id) VALUES ($1,$2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(`INSERT INTO prospect_cases (id,organization_id) VALUES ($1,$2)`, [
    caseId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO case_participants (organization_id,case_id,person_id,role)
     VALUES ($1,$2,$3,'REQUESTER')`,
    [organizationId, caseId, personId],
  );
  const contactPointId = await pool
    .query<{ id: string }>(
      `INSERT INTO contact_points
        (organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose)
       VALUES ($1,$2,'EMAIL','synthetic-ciphertext',$3,'TEST','BRIEF_DELIVERY') RETURNING id`,
      [organizationId, personId, randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  return { organizationId, caseId, contactPointId, purpose: BRIEF_DELIVERY_PURPOSE };
}

describe("case-scoped email verification challenges", () => {
  it("stores only a digest and replaces the pending challenge with lineage", async () => {
    const target = await scope();
    const firstToken = `secret-${randomUUID()}`;
    const first = await store.createChallenge({
      ...target,
      tokenDigest: digest(firstToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const second = await store.createChallenge({
      ...target,
      tokenDigest: digest(`replacement-${randomUUID()}`),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rows = await pool.query<{
      id: string;
      token_digest: string;
      status: string;
      previous_challenge_id: string | null;
    }>(
      `SELECT id,token_digest,status,previous_challenge_id
       FROM email_verification_challenges WHERE organization_id=$1 AND case_id=$2 ORDER BY created_at`,
      [organizationId, target.caseId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: first.id, status: "REVOKED" });
    expect(rows.rows[1]).toMatchObject({ id: second.id, previous_challenge_id: first.id });
    expect(JSON.stringify(rows.rows)).not.toContain(firstToken);
  });

  it("limits invalid attempts and never verifies the contact", async () => {
    const target = await scope();
    const correctToken = `correct-${randomUUID()}`;
    const challenge = await store.createChallenge({
      ...target,
      tokenDigest: digest(correctToken),
      expiresAt: new Date(Date.now() + 60_000),
      maxAttempts: 2,
    });
    await expect(
      store.consumeChallenge({
        ...target,
        challengeId: challenge.id,
        tokenDigest: digest("wrong-1"),
      }),
    ).resolves.toEqual({ verified: false });
    await expect(
      store.consumeChallenge({
        ...target,
        challengeId: challenge.id,
        tokenDigest: digest("wrong-2"),
      }),
    ).resolves.toEqual({ verified: false });
    await expect(
      store.consumeChallenge({
        ...target,
        challengeId: challenge.id,
        tokenDigest: digest(correctToken),
      }),
    ).resolves.toEqual({ verified: false });
    const state = await pool.query<{
      status: string;
      attempt_count: number;
      verified_at: Date | null;
    }>(
      `SELECT c.status,c.attempt_count,p.verified_at FROM email_verification_challenges c
       JOIN contact_points p ON p.id=c.contact_point_id WHERE c.id=$1`,
      [challenge.id],
    );
    expect(state.rows[0]).toMatchObject({ status: "REVOKED", attempt_count: 2, verified_at: null });
  });

  it("consumes an exact challenge once and rejects expired or foreign scopes", async () => {
    const target = await scope();
    const foreign = await scope();
    const tokenDigest = digest(`consume-${randomUUID()}`);
    const challenge = await store.createChallenge({
      ...target,
      tokenDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      store.consumeChallenge({ ...foreign, challengeId: challenge.id, tokenDigest }),
    ).resolves.toEqual({ verified: false });
    await expect(
      store.consumeChallenge({ ...target, challengeId: challenge.id, tokenDigest }),
    ).resolves.toEqual({ verified: true });
    await expect(
      store.consumeChallenge({ ...target, challengeId: challenge.id, tokenDigest }),
    ).resolves.toEqual({ verified: false });

    const expiredDigest = digest(`expired-${randomUUID()}`);
    const expired = await store.createChallenge({
      ...foreign,
      tokenDigest: expiredDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      store.consumeChallenge(
        { ...foreign, challengeId: expired.id, tokenDigest: expiredDigest },
        new Date(Date.now() + 120_000),
      ),
    ).resolves.toEqual({ verified: false });
    const states = await pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM email_verification_challenges WHERE id=ANY($1::uuid[])`,
      [[challenge.id, expired.id]],
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.status]))).toEqual({
      [challenge.id]: "CONSUMED",
      [expired.id]: "EXPIRED",
    });
  });

  it("returns one non-enumerating result and lets only one concurrent consumer verify", async () => {
    const target = await scope();
    const foreign = await scope();
    const token = `race-${randomUUID()}`;
    const foreignToken = `foreign-${randomUUID()}`;
    const challenge = await store.createChallenge({
      ...target,
      tokenDigest: digest(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const other = await store.createChallenge({
      ...foreign,
      tokenDigest: digest(foreignToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rejected = { verified: false };
    await expect(store.verifyChallenge({ challengeId: "not-a-uuid", token })).resolves.toEqual(
      rejected,
    );
    await expect(store.verifyChallenge({ challengeId: randomUUID(), token })).resolves.toEqual(
      rejected,
    );
    await expect(
      store.verifyChallenge({ challengeId: challenge.id, token: foreignToken }),
    ).resolves.toEqual(rejected);
    await expect(store.verifyChallenge({ challengeId: other.id, token })).resolves.toEqual(
      rejected,
    );

    const race = await Promise.all([
      store.verifyChallenge({ challengeId: challenge.id, token }),
      store.verifyChallenge({ challengeId: challenge.id, token }),
    ]);
    expect(race.filter((result) => result.verified)).toHaveLength(1);
    await expect(store.verifyChallenge({ challengeId: challenge.id, token })).resolves.toEqual(
      rejected,
    );
  });
});

describe("durable verification email outbox", () => {
  const codec = new AesGcmEmailSecretCodec(Buffer.alloc(32, 9), "integration-key");

  it("replays a logical request and retries with the exact same encrypted payload", async () => {
    const target = await scope();
    const request = {
      ...target,
      destination: "prospect@example.invalid",
      verificationBaseUrl: "https://example.invalid/verificar",
      idempotencyKey: `verification-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      sealer: codec,
    };
    const created = await outbox.request(request);
    await expect(outbox.request(request)).resolves.toEqual({ ...created, replayed: true });
    const port = new FakeEmailPort([
      { kind: "rejected", errorCode: "temporary", retryable: true },
      { kind: "accepted", externalId: "email.integration" },
    ]);
    const dispatcher = new EmailOutboxDispatcher(outbox, port, codec);
    dispatcher.setEnabled(true);
    await expect(dispatcher.dispatchOne()).resolves.toMatchObject({ kind: "rejected" });
    await pool.query(`UPDATE outbox_events SET available_at=now() WHERE id=$1`, [
      created.outboxEventId,
    ]);
    await expect(dispatcher.dispatchOne()).resolves.toEqual({
      kind: "accepted",
      externalId: "email.integration",
    });
    expect(port.sent).toHaveLength(2);
    expect(port.sent[0]).toEqual(port.sent[1]);
    const state = await pool.query<{
      payload: Record<string, unknown>;
      ciphertext: Buffer | null;
      destroyed_at: Date | null;
    }>(
      `SELECT o.payload,s.ciphertext,s.destroyed_at FROM outbox_events o
       JOIN email_verification_outbox_secrets s ON s.challenge_id=o.aggregate_id WHERE o.id=$1`,
      [created.outboxEventId],
    );
    expect(JSON.stringify(state.rows[0]?.payload)).not.toContain("prospect@example.invalid");
    expect(state.rows[0]?.ciphertext).toBeNull();
    expect(state.rows[0]?.destroyed_at).toBeInstanceOf(Date);
  });

  it("revokes and destroys the prior challenge on explicit resend or contact change", async () => {
    const target = await scope();
    const initial = await outbox.request({
      ...target,
      destination: "first@example.invalid",
      verificationBaseUrl: "https://example.invalid/verificar",
      idempotencyKey: `initial-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      sealer: codec,
    });
    const replacement = await outbox.request({
      ...target,
      destination: "first@example.invalid",
      verificationBaseUrl: "https://example.invalid/verificar",
      idempotencyKey: `resend-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      explicitResend: true,
      sealer: codec,
    });
    const states = await pool.query<{ id: string; status: string; destroyed_at: Date | null }>(
      `SELECT c.id,c.status,s.destroyed_at FROM email_verification_challenges c
       JOIN email_verification_outbox_secrets s ON s.challenge_id=c.id
       WHERE c.id=ANY($1::uuid[]) ORDER BY c.created_at`,
      [[initial.challengeId, replacement.challengeId]],
    );
    expect(states.rows[0]).toMatchObject({ id: initial.challengeId, status: "REVOKED" });
    expect(states.rows[0]?.destroyed_at).toBeInstanceOf(Date);
    expect(states.rows[1]).toMatchObject({ id: replacement.challengeId, status: "PENDING" });

    const secondReplacement = await outbox.request({
      ...target,
      destination: "first@example.invalid",
      verificationBaseUrl: "https://example.invalid/verificar",
      idempotencyKey: `resend-second-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      explicitResend: true,
      sealer: codec,
    });
    await expect(
      outbox.request({
        ...target,
        destination: "first@example.invalid",
        verificationBaseUrl: "https://example.invalid/verificar",
        idempotencyKey: `resend-limited-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        explicitResend: true,
        sealer: codec,
      }),
    ).rejects.toThrow("verification_resend_limited");

    await outbox.changeContact({
      ...target,
      valueCiphertext: "changed-synthetic-ciphertext",
      fingerprint: randomUUID(),
    });
    const changed = await pool.query<{ status: string; destroyed_at: Date | null }>(
      `SELECT c.status,s.destroyed_at FROM email_verification_challenges c
       JOIN email_verification_outbox_secrets s ON s.challenge_id=c.id WHERE c.id=$1`,
      [secondReplacement.challengeId],
    );
    expect(changed.rows[0]?.status).toBe("REVOKED");
    expect(changed.rows[0]?.destroyed_at).toBeInstanceOf(Date);
  });
});
