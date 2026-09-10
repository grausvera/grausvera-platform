import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { QuotaStore } from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new QuotaStore(connectionString);
let organizationId: string;
const personId = randomUUID();
const contactPointId = randomUUID();
const connectionId = randomUUID();
let consentPolicyId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
       source, purpose, provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
       'synthetic', 'quota-test', 'META', $5)`,
    [contactPointId, organizationId, personId, `quota-${contactPointId}`, `quota-${personId}`],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/quota')`,
    [connectionId, organizationId, `quota-${connectionId}`],
  );
  consentPolicyId = await pool
    .query<{ id: string }>(
      `WITH inserted AS (
       INSERT INTO consent_policies
      (id, organization_id, purpose, channel, locale, version, notice_text,
       notice_hash, scope, effective_at)
     VALUES ($1, $2, 'DISCOVERY', 'WHATSAPP', 'es-PE-quota', 1, 'synthetic notice',
       repeat('a', 64), 'PROJECT_DISCOVERY', now() - interval '1 hour')
     ON CONFLICT (organization_id, purpose, channel, locale, version)
     DO NOTHING RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM consent_policies
     WHERE organization_id = $2 AND purpose = 'DISCOVERY' AND channel = 'WHATSAPP'
       AND locale = 'es-PE-quota' AND version = 1
     LIMIT 1`,
      [randomUUID(), organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await setQuotaPolicy(1, { caseMessages: 2, contactMessages: 3, activeSeconds: 600 });
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

async function setQuotaPolicy(
  version: number,
  limits: { caseMessages: number; contactMessages: number; activeSeconds: number },
) {
  await pool.query(
    `INSERT INTO quota_policies
      (organization_id, version, period_seconds, case_message_limit,
       contact_message_limit, case_active_seconds_limit, effective_at)
     VALUES ($1, $2, 86400, $3, $4, $5, now() - interval '1 minute')
     ON CONFLICT (organization_id, version) DO NOTHING`,
    [organizationId, version, limits.caseMessages, limits.contactMessages, limits.activeSeconds],
  );
}

async function createConsentedCase(contactId = contactPointId) {
  const caseId = randomUUID();
  const conversationId = randomUUID();
  const consentMessageId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status, next_action)
     VALUES ($1, $2, 'INTERVIEWING', 'ASK_QUESTION')`,
    [caseId, organizationId],
  );
  await pool.query(
    `INSERT INTO case_participants (organization_id, case_id, person_id, role)
     VALUES ($1, $2, $3, 'REQUESTER')`,
    [organizationId, caseId, personId],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      consentMessageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.consent.${consentMessageId}`,
      Buffer.from("ACEPTO"),
      personId,
      contactId,
    ],
  );
  await pool.query(
    `INSERT INTO consent_records
      (organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
       action, source_message_id, policy_version, notice_hash, channel, locale,
       scope, occurred_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'DISCOVERY', 'ACCEPTED', $6, 1,
       repeat('a', 64), 'WHATSAPP', 'es-PE-quota', 'PROJECT_DISCOVERY', now(), $7)`,
    [organizationId, caseId, personId, contactId, consentPolicyId, consentMessageId, randomUUID()],
  );
  return { caseId, conversationId };
}

async function inbound(caseId: string, conversationId: string, contactId = contactPointId) {
  const messageId = randomUUID();
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      messageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.quota.${messageId}`,
      Buffer.from("synthetic message"),
      personId,
      contactId,
    ],
  );
  return messageId;
}

describe("durable usage quotas", () => {
  it("counts a replay once and pauses atomically at the case limit", async () => {
    const { caseId, conversationId } = await createConsentedCase();
    const firstMessage = await inbound(caseId, conversationId);
    const [first, replay] = await Promise.all([
      store.consumeInbound({
        organizationId,
        messageId: firstMessage,
        correlationId: randomUUID(),
      }),
      store.consumeInbound({
        organizationId,
        messageId: firstMessage,
        correlationId: randomUUID(),
      }),
    ]);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
    expect(first.caseMessages).toBe(1);
    expect(replay.caseMessages).toBe(1);

    const pendingId = randomUUID();
    const dispatchingId = randomUUID();
    for (const [id, status] of [
      [pendingId, "PENDING"],
      [dispatchingId, "DISPATCHING"],
    ] as const) {
      await pool.query(
        `INSERT INTO outbox_events
          (id, organization_id, case_id, event_type, aggregate_type, aggregate_id,
           payload, idempotency_key, status, deadline_at, locked_at)
         VALUES ($1, $2, $3, 'whatsapp.interview.question.v1', 'message', $4,
           '{}', $5, $6::outbox_status, now() + interval '1 hour',
           CASE WHEN $6 = 'DISPATCHING' THEN now() ELSE NULL END)`,
        [id, organizationId, caseId, randomUUID(), `quota-${id}`, status],
      );
    }
    await pool.query(
      `INSERT INTO message_delivery_attempts (outbox_event_id, attempt_number)
       VALUES ($1, 1)`,
      [dispatchingId],
    );
    const secondMessage = await inbound(caseId, conversationId);
    expect(
      await store.consumeInbound({
        organizationId,
        messageId: secondMessage,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({ created: true, exceeded: true, reason: "CASE_MESSAGE_LIMIT" });

    const state = await pool.query(
      `SELECT pc.status, pc.next_action,
              (SELECT count(*)::integer FROM quota_consumptions WHERE message_id IN ($2, $3)) AS consumptions,
              (SELECT count(*)::integer FROM audit_events WHERE case_id = $1 AND action = 'quota.exceeded') AS audits,
              (SELECT count(*)::integer FROM outbox_events WHERE id IN ($4, $5) AND status = 'CANCELLED') AS cancelled,
              (SELECT count(*)::integer FROM message_delivery_attempts WHERE outbox_event_id = $5
                AND completed_at IS NOT NULL AND error_code = 'quota_exceeded') AS closed_attempts
       FROM prospect_cases pc WHERE pc.id = $1`,
      [caseId, firstMessage, secondMessage, pendingId, dispatchingId],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "QUOTA_EXCEEDED",
      consumptions: 2,
      audits: 1,
      cancelled: 2,
      closed_attempts: 1,
    });
  });

  it("shares the contact limit across cases without losing either case", async () => {
    const { caseId, conversationId } = await createConsentedCase();
    const messageId = await inbound(caseId, conversationId);
    expect(
      await store.consumeInbound({ organizationId, messageId, correlationId: randomUUID() }),
    ).toMatchObject({ exceeded: true, reason: "CONTACT_MESSAGE_LIMIT", contactMessages: 3 });
    const state = await pool.query(`SELECT status, next_action FROM prospect_cases WHERE id = $1`, [
      caseId,
    ]);
    expect(state.rows[0]).toEqual({ status: "PAUSED", next_action: "QUOTA_EXCEEDED" });
  });

  it("accounts active time once and resets counters only after the durable window ends", async () => {
    await setQuotaPolicy(2, { caseMessages: 20, contactMessages: 20, activeSeconds: 10 });
    const secondContactId = randomUUID();
    await pool.query(
      `INSERT INTO contact_points
        (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
         source, purpose, provider, external_id)
       VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
         'synthetic', 'quota-test', 'META', $5)`,
      [
        secondContactId,
        organizationId,
        personId,
        `quota-${secondContactId}`,
        `quota-${secondContactId}`,
      ],
    );
    const { caseId, conversationId } = await createConsentedCase(secondContactId);
    const firstMessage = await inbound(caseId, conversationId, secondContactId);
    await store.consumeInbound({
      organizationId,
      messageId: firstMessage,
      correlationId: randomUUID(),
    });
    await pool.query(
      `UPDATE case_quota_usages SET active_seconds = 9,
         last_accounted_at = now() - interval '2 seconds' WHERE case_id = $1`,
      [caseId],
    );
    const secondMessage = await inbound(caseId, conversationId, secondContactId);
    expect(
      await store.consumeInbound({
        organizationId,
        messageId: secondMessage,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({ exceeded: true, reason: "CASE_ACTIVE_TIME_LIMIT" });

    await setQuotaPolicy(3, { caseMessages: 20, contactMessages: 20, activeSeconds: 600 });
    const thirdContactId = randomUUID();
    await pool.query(
      `INSERT INTO contact_points
        (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
         source, purpose, provider, external_id)
       VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
         'synthetic', 'quota-test', 'META', $5)`,
      [
        thirdContactId,
        organizationId,
        personId,
        `quota-${thirdContactId}`,
        `quota-${thirdContactId}`,
      ],
    );
    const resetCase = await createConsentedCase(thirdContactId);
    const beforeExpiry = await inbound(resetCase.caseId, resetCase.conversationId, thirdContactId);
    await store.consumeInbound({
      organizationId,
      messageId: beforeExpiry,
      correlationId: randomUUID(),
    });
    await pool.query(
      `UPDATE case_quota_usages SET window_started_at = now() - interval '2 days',
         window_ends_at = now() - interval '1 second', last_accounted_at = now() - interval '1 day'
       WHERE case_id = $1`,
      [resetCase.caseId],
    );
    await pool.query(
      `UPDATE contact_quota_usages SET window_started_at = now() - interval '2 days',
         window_ends_at = now() - interval '1 second'
       WHERE contact_point_id = $1`,
      [thirdContactId],
    );
    const afterExpiry = await inbound(resetCase.caseId, resetCase.conversationId, thirdContactId);
    expect(
      await store.consumeInbound({
        organizationId,
        messageId: afterExpiry,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({ exceeded: false, caseMessages: 1, contactMessages: 1 });
  });

  it("keeps policies and individual consumptions immutable", async () => {
    await expect(
      pool.query(`UPDATE quota_policies SET case_message_limit = 999 WHERE organization_id = $1`, [
        organizationId,
      ]),
    ).rejects.toThrow("quota evidence is immutable");
    await expect(
      pool.query(
        `DELETE FROM quota_consumptions WHERE organization_id = $1 AND id =
          (SELECT id FROM quota_consumptions WHERE organization_id = $1 LIMIT 1)`,
        [organizationId],
      ),
    ).rejects.toThrow("quota evidence is immutable");
  });
});
